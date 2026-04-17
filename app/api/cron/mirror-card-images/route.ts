import { NextResponse } from "next/server";

import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  canonicalStorageKey,
  mirrorImage,
  printingStorageKey,
} from "@/lib/images/mirror";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const PER_ROW_CONCURRENCY = 4;

type PrintingRow = {
  id: string;
  source: string;
  source_id: string | null;
  image_url: string | null;
};

type CanonicalRow = {
  slug: string;
  primary_image_url: string | null;
};

type OutcomeCounts = {
  attempted: number;
  succeeded: number;
  failed: number;
};

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Mirror provider card images (typically Scrydex) into Supabase Storage.
 *
 * Claim pattern: each invocation processes up to `batch` rows from each of
 * `card_printings` and `canonical_cards` that (a) have a source URL and
 * (b) haven't been mirrored yet, with `image_mirror_attempts < 5`.
 * Matches the partial indexes added in 20260416234500_card_image_mirror.sql.
 */
export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const batch = parsePositiveInt(url.searchParams.get("batch"), DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);

  const supabase = dbAdmin();
  const startedAt = Date.now();

  const [printingsResult, canonicalResult] = await Promise.all([
    mirrorPrintingsBatch(supabase, batch),
    mirrorCanonicalBatch(supabase, batch),
  ]);

  return NextResponse.json(
    {
      ok: true,
      duration_ms: Date.now() - startedAt,
      printings: printingsResult,
      canonical: canonicalResult,
    },
    { status: 200 },
  );
}

async function mirrorPrintingsBatch(
  supabase: ReturnType<typeof dbAdmin>,
  batch: number,
): Promise<OutcomeCounts> {
  const { data, error } = await supabase
    .from("card_printings")
    .select("id, source, source_id, image_url")
    .not("image_url", "is", null)
    .is("image_mirrored_at", null)
    .lt("image_mirror_attempts", 5)
    .limit(batch);

  if (error) {
    throw new Error(`select card_printings backlog: ${error.message}`);
  }

  const rows = (data ?? []) as PrintingRow[];
  return processRows(rows, PER_ROW_CONCURRENCY, (row) => mirrorPrinting(supabase, row));
}

async function mirrorCanonicalBatch(
  supabase: ReturnType<typeof dbAdmin>,
  batch: number,
): Promise<OutcomeCounts> {
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, primary_image_url")
    .not("primary_image_url", "is", null)
    .is("image_mirrored_at", null)
    .lt("image_mirror_attempts", 5)
    .limit(batch);

  if (error) {
    throw new Error(`select canonical_cards backlog: ${error.message}`);
  }

  const rows = (data ?? []) as CanonicalRow[];
  return processRows(rows, PER_ROW_CONCURRENCY, (row) => mirrorCanonical(supabase, row));
}

async function mirrorPrinting(
  supabase: ReturnType<typeof dbAdmin>,
  row: PrintingRow,
): Promise<boolean> {
  if (!row.image_url) return false;
  const storageKey = printingStorageKey(row.source, row.source_id, row.id);
  try {
    const { fullUrl, thumbUrl } = await mirrorImage(row.image_url, storageKey, supabase);
    const { error } = await supabase
      .from("card_printings")
      .update({
        mirrored_image_url: fullUrl,
        mirrored_thumb_url: thumbUrl,
        image_mirrored_at: new Date().toISOString(),
        image_mirror_last_error: null,
      })
      .eq("id", row.id);
    if (error) throw new Error(`update card_printings: ${error.message}`);
    return true;
  } catch (err) {
    await recordPrintingFailure(supabase, row.id, err);
    return false;
  }
}

async function mirrorCanonical(
  supabase: ReturnType<typeof dbAdmin>,
  row: CanonicalRow,
): Promise<boolean> {
  if (!row.primary_image_url) return false;
  const storageKey = canonicalStorageKey(row.slug);
  try {
    const { fullUrl, thumbUrl } = await mirrorImage(row.primary_image_url, storageKey, supabase);
    const { error } = await supabase
      .from("canonical_cards")
      .update({
        mirrored_primary_image_url: fullUrl,
        mirrored_primary_thumb_url: thumbUrl,
        image_mirrored_at: new Date().toISOString(),
        image_mirror_last_error: null,
      })
      .eq("slug", row.slug);
    if (error) throw new Error(`update canonical_cards: ${error.message}`);
    return true;
  } catch (err) {
    await recordCanonicalFailure(supabase, row.slug, err);
    return false;
  }
}

async function recordPrintingFailure(
  supabase: ReturnType<typeof dbAdmin>,
  id: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // Fetch current attempt count, then write incremented value. Two crons
  // won't contend for the same row because the batch query returns
  // attempts < 5 and the update path doesn't re-claim in-flight rows
  // beyond the partial index's guarantees.
  const { data } = await supabase
    .from("card_printings")
    .select("image_mirror_attempts")
    .eq("id", id)
    .maybeSingle();
  const attempts = (data?.image_mirror_attempts as number | null | undefined) ?? 0;
  await supabase
    .from("card_printings")
    .update({
      image_mirror_attempts: attempts + 1,
      image_mirror_last_error: message.slice(0, 500),
    })
    .eq("id", id);
}

async function recordCanonicalFailure(
  supabase: ReturnType<typeof dbAdmin>,
  slug: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { data } = await supabase
    .from("canonical_cards")
    .select("image_mirror_attempts")
    .eq("slug", slug)
    .maybeSingle();
  const attempts = (data?.image_mirror_attempts as number | null | undefined) ?? 0;
  await supabase
    .from("canonical_cards")
    .update({
      image_mirror_attempts: attempts + 1,
      image_mirror_last_error: message.slice(0, 500),
    })
    .eq("slug", slug);
}

async function processRows<T>(
  rows: T[],
  concurrency: number,
  handle: (row: T) => Promise<boolean>,
): Promise<OutcomeCounts> {
  let index = 0;
  let succeeded = 0;
  let failed = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= rows.length) return;
      const ok = await handle(rows[i]!);
      if (ok) succeeded += 1;
      else failed += 1;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(workers);

  return { attempted: rows.length, succeeded, failed };
}

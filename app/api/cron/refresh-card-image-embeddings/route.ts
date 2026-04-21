/**
 * Cron: refresh-card-image-embeddings
 *
 * Walks canonical_cards in slug-order, selects rows whose Scrydex image
 * has been mirrored into Supabase Storage, and embeds those mirrored
 * URLs with the configured ImageEmbedder (CLIP ViT-L/14 via Replicate
 * for v1). Vectors land in Neon's card_image_embeddings, keyed by
 * canonical_slug. Safe to re-run — rows whose (source_image_url,
 * model_version) hash is unchanged get skipped.
 *
 * Backfill path, not user-facing. Rate-limited by the configured batch
 * size per invocation; the Vercel cron schedule drains the queue over
 * many runs.
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  hasVercelPostgresConfig,
  refreshCardImageEmbeddingBatch,
  type EmbeddableCardImage,
} from "@/lib/ai/card-image-embeddings";
import {
  getReplicateClipEmbedder,
  hasReplicateConfig,
  ImageEmbedderConfigError,
  ImageEmbedderRuntimeError,
} from "@/lib/ai/image-embedder";

export const runtime = "nodejs";
export const maxDuration = 300;

const FETCH_BATCH_SIZE = 32;
const DEFAULT_MAX_CARDS = 256;
const MAX_CARDS_LIMIT = 1024;
/**
 * Max attempts per canonical card before the cron stops retrying its
 * mirrored image URL. Matches the card-image-mirror pattern — after 5
 * strikes, an operator has to investigate and reset the counter.
 */
const MAX_EMBED_ATTEMPTS = 5;

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  language: string | null;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  mirrored_primary_image_url: string | null;
  image_embed_attempts: number | null;
};

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  if (!hasVercelPostgresConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing Vercel Postgres connection string. Set POSTGRES_URL." },
      { status: 500 },
    );
  }

  if (!hasReplicateConfig()) {
    return NextResponse.json(
      { ok: false, error: "Missing REPLICATE_API_TOKEN or REPLICATE_CLIP_MODEL_VERSION." },
      { status: 500 },
    );
  }

  let embedder;
  try {
    embedder = getReplicateClipEmbedder();
  } catch (err) {
    if (err instanceof ImageEmbedderConfigError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const cursor = searchParams.get("cursor") ?? "";

  const supabase = dbAdmin();
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let lastSlug: string | null = cursor ? cursor : null;

  while (processed < maxCards) {
    const remaining = maxCards - processed;
    const pageSize = Math.min(FETCH_BATCH_SIZE, remaining);

    // Filter out rows that are already embedded (image_embedded_at is
    // set) so the per-invocation maxCards budget is spent on new work,
    // not re-walking the finished catalog. Rows predating the tracking
    // columns get stamped the first time they hash-skip, after which
    // this filter excludes them permanently.
    let query = supabase
      .from("canonical_cards")
      .select(
        "slug, canonical_name, language, set_name, card_number, variant, mirrored_primary_image_url, image_embed_attempts",
      )
      .not("mirrored_primary_image_url", "is", null)
      .lt("image_embed_attempts", MAX_EMBED_ATTEMPTS)
      .is("image_embedded_at", null)
      .order("slug", { ascending: true })
      .limit(pageSize);

    if (lastSlug) {
      query = query.gt("slug", lastSlug);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as CanonicalRow[];
    if (rows.length === 0) break;

    const cards: EmbeddableCardImage[] = rows
      .filter((row): row is CanonicalRow & { mirrored_primary_image_url: string } =>
        Boolean(row.mirrored_primary_image_url),
      )
      .map((row) => ({
        slug: row.slug,
        canonical_name: row.canonical_name,
        language: row.language,
        set_name: row.set_name,
        card_number: row.card_number,
        variant: row.variant,
        source_image_url: row.mirrored_primary_image_url,
      }));

    try {
      const batchResult = await refreshCardImageEmbeddingBatch(cards, embedder);
      processed += batchResult.processed;
      updated += batchResult.updated;
      skipped += batchResult.skipped;
      failed += batchResult.failed;

      await recordEmbedOutcomes(
        supabase,
        batchResult.successSlugs,
        batchResult.failureReasons,
        rows,
      );
    } catch (err) {
      if (err instanceof ImageEmbedderRuntimeError) {
        return NextResponse.json(
          {
            ok: false,
            error: err.message,
            processed,
            updated,
            skipped,
            failed,
            last_slug: lastSlug,
          },
          { status: 502 },
        );
      }
      throw err;
    }

    lastSlug = rows[rows.length - 1]!.slug;

    if (rows.length < pageSize) break;
  }

  return NextResponse.json({
    ok: true,
    processed,
    updated,
    skipped,
    failed,
    last_slug: lastSlug,
    max_cards: maxCards,
    model_version: embedder.modelVersion,
  });
}

/**
 * Persist per-slug outcomes onto canonical_cards so the next cron pass
 * skips burnt-out URLs and the operator has diagnostics.
 *
 * Successes clear the attempts counter (self-heals transient failures)
 * and stamp image_embedded_at. Failures bump the counter and store the
 * last error message.
 */
async function recordEmbedOutcomes(
  supabase: ReturnType<typeof dbAdmin>,
  successSlugs: string[],
  failureReasons: Array<{ slug: string; error: string }>,
  rows: CanonicalRow[],
): Promise<void> {
  if (successSlugs.length > 0) {
    const { error } = await supabase
      .from("canonical_cards")
      .update({
        image_embed_attempts: 0,
        image_embed_last_error: null,
        image_embedded_at: new Date().toISOString(),
      })
      .in("slug", successSlugs);

    if (error) {
      console.warn(`[refresh-card-image-embeddings] success write-back failed: ${error.message}`);
    }
  }

  if (failureReasons.length > 0) {
    const attemptsBySlug = new Map<string, number>();
    for (const row of rows) {
      attemptsBySlug.set(row.slug, row.image_embed_attempts ?? 0);
    }

    // Per-row attempts increment mirrors the card-image-mirror cron
    // pattern. Three reasons we don't batch this: (1) Supabase REST
    // can't express `attempts = attempts + 1` in a single update,
    // (2) attempts counts can diverge per row, (3) each write is small
    // and rare (only known-broken URLs hit this path).
    for (const { slug, error } of failureReasons) {
      const nextAttempts = (attemptsBySlug.get(slug) ?? 0) + 1;
      // Guard against lost-race overwrite: a concurrent cron invocation
      // may have claimed the same row, succeeded, and already stamped
      // image_embedded_at before our failure write lands. In that case
      // the vector is safely in Neon and we must NOT smear stale
      // attempt/error metadata back over the successful row. The
      // `.is("image_embedded_at", null)` predicate turns this update
      // into a no-op once the row has been marked embedded.
      const { error: updateError } = await supabase
        .from("canonical_cards")
        .update({
          image_embed_attempts: nextAttempts,
          image_embed_last_error: error.slice(0, 500),
        })
        .eq("slug", slug)
        .is("image_embedded_at", null);

      if (updateError) {
        console.warn(
          `[refresh-card-image-embeddings] failure write-back for ${slug} failed: ${updateError.message}`,
        );
      }
    }
  }
}

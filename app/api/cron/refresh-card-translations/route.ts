/**
 * Cron: refresh-card-translations
 *
 * Weekly maintenance pass over the EN <-> JP card pairing junction
 * table (public.card_translations). Each invocation walks a bounded
 * slice of EN canonical_cards that have an active-variant image
 * embedding and either (a) no card_translations row keyed under
 * their slug, or (b) a row older than their canonical_cards.updated_at.
 *
 * The pairing signal is identical to scripts/backfill-card-translations.mjs:
 *
 *   1. SigLIP top-K kNN against JP rows in card_image_embeddings.
 *   2. JP-name glossary gate (EN_TO_JP_POKEMON) — when both sides
 *      have native names, demand a glossary hit; otherwise raise the
 *      cosine floor.
 *   3. card_number string equality bumps the score as a tiebreak.
 *   4. Primary writes at cosine >= MIN_PRIMARY_COSINE, alternates at
 *      cosine >= MIN_ALT_COSINE.
 *
 * The script does the initial heavy backfill; this cron's job is to
 * absorb (a) newly-imported JP catalog rows (the import is ongoing,
 * per memory: 14.8k matched today, ~23k target) and (b) any EN cards
 * whose embeddings rotated under a model swap.
 *
 * Schedule: weekly Sunday 03:00 UTC. Long cadence is intentional —
 * pairings are stable once established, and the new-JP-catalog
 * delta is small per week.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { hasVercelPostgresConfig } from "@/lib/ai/card-embeddings";
import {
  IMAGE_EMBEDDER_MODEL_VERSION,
} from "@/lib/ai/image-embedder";
import { EN_TO_JP_POKEMON } from "@/lib/jp/matcher.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MAX_CARDS = 200;
const MAX_CARDS_LIMIT = 1000;
const TOP_K = 8;
const MIN_PRIMARY_COSINE = 0.90;
const MIN_ALT_COSINE = 0.85;
const NO_GLOSSARY_FLOOR_COSINE = 0.94;
const ALT_RANK_MAX = 2;

type EnRow = {
  slug: string;
  canonical_name: string;
  canonical_name_native: string | null;
  card_number: string | null;
};

type JpCandidate = {
  jp_slug: string;
  cos_dist: number;
  cosine: number;
  card: {
    slug: string;
    canonical_name: string;
    canonical_name_native: string | null;
    card_number: string | null;
    language: string | null;
  } | null;
};

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

function nameGlossaryGate(en: EnRow, jp: NonNullable<JpCandidate["card"]>): boolean | null {
  const enBase = (en.canonical_name ?? "").trim().toLowerCase();
  const enBaseSpecies = enBase.split(/\s+/)[0];
  const expectedJp = (EN_TO_JP_POKEMON as Record<string, string>)[enBase] ?? (EN_TO_JP_POKEMON as Record<string, string>)[enBaseSpecies] ?? null;
  const jpNative = (jp.canonical_name_native ?? "").trim();
  if (!jpNative || !expectedJp) return null;
  return jpNative.includes(expectedJp);
}

function cardNumberMatch(en: EnRow, jp: NonNullable<JpCandidate["card"]>): boolean {
  const a = String(en.card_number ?? "").trim();
  const b = String(jp.card_number ?? "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const norm = (s: string) => s.split("/")[0].replace(/^0+(?=\d)/, "").trim();
  return norm(a) === norm(b);
}

type Pairing = { jp_slug: string; confidence: number; rank: number };

function pickPairings(en: EnRow, candidates: JpCandidate[]): Pairing[] {
  const scored = candidates
    .filter((c): c is JpCandidate & { card: NonNullable<JpCandidate["card"]> } => !!c.card)
    .map((c) => {
      const numberBoost = cardNumberMatch(en, c.card) ? 0.02 : 0;
      return { ...c, score: c.cosine + numberBoost };
    })
    .sort((a, b) => b.score - a.score);

  const accepted: typeof scored = [];
  for (const cand of scored) {
    const gate = nameGlossaryGate(en, cand.card);
    let qualifies: boolean;
    if (gate === true) {
      qualifies = cand.cosine >= MIN_ALT_COSINE;
    } else if (gate === false) {
      continue;
    } else {
      qualifies = cand.cosine >= NO_GLOSSARY_FLOOR_COSINE;
    }
    if (!qualifies) continue;
    accepted.push(cand);
    if (accepted.length > ALT_RANK_MAX + 1) break;
  }
  if (accepted.length === 0) return [];

  const primary = accepted[0]!.cosine >= MIN_PRIMARY_COSINE ? accepted[0]! : null;
  const alts = (primary ? accepted.slice(1) : accepted).slice(0, ALT_RANK_MAX);
  const rows: Pairing[] = [];
  if (primary) rows.push({ jp_slug: primary.card!.slug, confidence: primary.cosine, rank: 0 });
  alts.forEach((a, i) => {
    rows.push({ jp_slug: a.card!.slug, confidence: a.cosine, rank: primary ? i + 1 : i });
  });
  return rows;
}

async function findJpCandidates(
  enSlug: string,
  modelVersion: string,
  supabase: ReturnType<typeof dbAdmin>,
): Promise<JpCandidate[]> {
  const knn = await sql.query(
    `
      with en_vec as (
        select embedding
          from card_image_embeddings
         where canonical_slug = $1
           and model_version = $2
           and variant_index = 0
           and crop_type = 'full'
         limit 1
      )
      select e.canonical_slug,
             (e.embedding <=> (select embedding from en_vec)) as cos_dist
        from card_image_embeddings e
       where e.model_version = $2
         and e.language = 'JP'
         and e.is_digital_only = false
         and e.crop_type = 'full'
         and e.variant_index = 0
         and exists (select 1 from en_vec)
       order by e.embedding <=> (select embedding from en_vec)
       limit $3
    `,
    [enSlug, modelVersion, TOP_K],
  );
  const candidates: JpCandidate[] = (knn.rows ?? []).map((r) => ({
    jp_slug: r.canonical_slug as string,
    cos_dist: Number(r.cos_dist),
    cosine: 1 - Number(r.cos_dist),
    card: null,
  }));
  if (candidates.length === 0) return [];

  const slugs = candidates.map((c) => c.jp_slug);
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, canonical_name_native, card_number, language")
    .in("slug", slugs);
  if (error) throw new Error(`hydrate JP candidates: ${error.message}`);
  const bySlug = new Map((data ?? []).map((r) => [r.slug as string, r as NonNullable<JpCandidate["card"]>]));
  return candidates.map((c) => ({ ...c, card: bySlug.get(c.jp_slug) ?? null }));
}

async function upsertPairings(enSlug: string, pairings: Pairing[]): Promise<number> {
  if (pairings.length === 0) return 0;
  const valuesSql = pairings
    .map((_, i) => `($1::text, $${i * 3 + 2}::text, $${i * 3 + 3}::real, $${i * 3 + 4}::smallint, 'image_embedding_v1'::text, now())`)
    .join(", ");
  const params: (string | number)[] = [enSlug];
  for (const p of pairings) {
    params.push(p.jp_slug, p.confidence, p.rank);
  }
  const result = await sql.query(
    `
      insert into card_translations
        (en_slug, jp_slug, confidence, rank, source, updated_at)
      select * from (values ${valuesSql}) as v(en_slug, jp_slug, confidence, rank, source, updated_at)
      on conflict (en_slug, jp_slug) do update
        set confidence = excluded.confidence,
            rank       = excluded.rank,
            source     = excluded.source,
            updated_at = now()
    `,
    params,
  );
  return result.rowCount ?? 0;
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

  const { searchParams } = new URL(req.url);
  const maxCards = parseMaxCards(searchParams.get("maxCards"));
  const cursor = searchParams.get("cursor") ?? null;
  const modelVersion = IMAGE_EMBEDDER_MODEL_VERSION;
  const supabase = dbAdmin();

  // Claim filter: EN cards whose embedding is stamped under the active
  // model_version AND which either have no card_translations row keyed
  // by their slug, or whose canonical row updated after the most recent
  // pairing row was written.
  //
  // The "no row" half is the main thing this cron picks up week to
  // week as the JP catalog grows. We express it as a NOT EXISTS so the
  // planner can use the card_translations_en_idx for the lookup. The
  // "row stale" half is rare but catches updates to canonical_name /
  // card_number that might change which JP candidate wins.
  let q = supabase
    .from("canonical_cards")
    .select("slug, canonical_name, canonical_name_native, card_number, updated_at")
    .eq("language", "EN")
    .eq("image_embedded_model_version", modelVersion)
    .order("slug", { ascending: true })
    .limit(maxCards);
  if (cursor) q = q.gt("slug", cursor);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<EnRow & { updated_at: string | null }>;
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      primary: 0,
      alts: 0,
      written: 0,
      last_slug: cursor,
      model_version: modelVersion,
      note: "no EN candidates",
    });
  }

  // Skip rows that already have a fresh pairing. One round-trip lookup
  // per batch — much cheaper than per-row.
  const slugs = rows.map((r) => r.slug);
  const { data: existing, error: existingErr } = await supabase
    .from("card_translations")
    .select("en_slug, updated_at")
    .in("en_slug", slugs);
  if (existingErr) {
    return NextResponse.json({ ok: false, error: `card_translations lookup: ${existingErr.message}` }, { status: 500 });
  }
  const pairingByEn = new Map<string, string | null>();
  for (const r of existing ?? []) {
    const prev = pairingByEn.get(r.en_slug as string);
    const next = r.updated_at as string | null;
    if (!prev || (next && (!prev || next > prev))) pairingByEn.set(r.en_slug as string, next);
  }
  const todo = rows.filter((r) => {
    const pairedAt = pairingByEn.get(r.slug);
    if (!pairedAt) return true;
    if (!r.updated_at) return false;
    return r.updated_at > pairedAt;
  });

  let processed = 0;
  let withPrimary = 0;
  let withAlts = 0;
  let written = 0;
  let lastSlug: string | null = cursor;

  for (const row of todo) {
    processed += 1;
    lastSlug = row.slug;
    try {
      const candidates = await findJpCandidates(row.slug, modelVersion, supabase);
      if (candidates.length === 0) continue;
      const pairings = pickPairings(row, candidates);
      if (pairings.length === 0) continue;
      if (pairings.some((p) => p.rank === 0)) withPrimary += 1;
      if (pairings.some((p) => p.rank > 0)) withAlts += 1;
      const rowsWritten = await upsertPairings(row.slug, pairings);
      written += rowsWritten;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-card-translations] ${row.slug} failed: ${message}`);
    }
  }

  // Advance the cursor to the last EN slug we PEEKED at (rows, not todo)
  // so the next invocation doesn't keep re-claiming the same skipped
  // batch.
  if (rows.length > 0) lastSlug = rows[rows.length - 1]!.slug;

  return NextResponse.json({
    ok: true,
    processed,
    skipped: rows.length - todo.length,
    primary: withPrimary,
    alts: withAlts,
    written,
    last_slug: lastSlug,
    max_cards: maxCards,
    model_version: modelVersion,
  });
}

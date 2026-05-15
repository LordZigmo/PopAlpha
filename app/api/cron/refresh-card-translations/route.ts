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
  // EN_TO_JP_POKEMON is keyed by title-case Pokemon names ("Bulbasaur",
  // "Charizard"). canonical_cards.canonical_name is also title-case.
  // Lowercasing before lookup made every glossary check miss and pushed
  // every kNN candidate through the strict noGlossaryFloorCosine (0.94)
  // gate, yielding zero pairings on the first prod cron run. Match the
  // glossary's casing exactly. Suffix stripping (" ex"/"VMAX"/"VSTAR")
  // happens by taking the first whitespace-delimited token.
  const enName = (en.canonical_name ?? "").trim();
  const enBaseSpecies = enName.split(/\s+/)[0]!;
  const glossary = EN_TO_JP_POKEMON as Record<string, string>;
  const expectedJp = glossary[enName] ?? glossary[enBaseSpecies] ?? null;
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
  // Primary must clear the cosine floor on its own merits — NOT the
  // score (cosine + numberBoost). `accepted` is sorted by score so
  // find() walks in that order; the chosen primary is the
  // highest-score candidate that also meets the raw cosine bar.
  // Higher-score-but-lower-cosine candidates fall back into the alts
  // bucket (they still cleared MIN_ALT_COSINE — that's how they got
  // into `accepted` to begin with).
  const primary = accepted.find((c) => c.cosine >= MIN_PRIMARY_COSINE);
  if (!primary) return [];
  const alts = accepted.filter((c) => c !== primary).slice(0, ALT_RANK_MAX);
  const rows: Pairing[] = [
    { jp_slug: primary.card!.slug, confidence: primary.cosine, rank: 0 },
  ];
  alts.forEach((a, i) => {
    rows.push({ jp_slug: a.card!.slug, confidence: a.cosine, rank: i + 1 });
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
  // Drop existing rows for this EN slug that AREN'T in the new pairing
  // set first. Plain ON CONFLICT (en_slug, jp_slug) can't catch a
  // rank=0 flipping to a different jp_slug — both rows would survive,
  // and the detail endpoint's .eq("rank", 0).maybeSingle() lookup
  // errors on the duplicate, hiding the toggle. The DELETE keeps any
  // jp_slug present in the new set so unchanged rows ride through;
  // the INSERT below updates their confidence/rank in place.
  const newJpSlugs = pairings.map((p) => p.jp_slug);
  await sql.query(
    `delete from card_translations where en_slug = $1 and jp_slug <> all($2::text[])`,
    [enSlug, newJpSlugs],
  );

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
  const modelVersion = IMAGE_EMBEDDER_MODEL_VERSION;
  const supabase = dbAdmin();

  // Candidate set: EN cards stamped under the active model_version
  // that don't yet have a primary (rank=0) pairing AND haven't been
  // tried in the last RETRY_INTERVAL_DAYS days.
  //
  // Two-axis advancement:
  //   1. NOT EXISTS card_translations WHERE rank=0 — successful
  //      pairings exit the set permanently.
  //   2. translation_attempted_at filter — unpairable slugs that
  //      were attempted recently exit temporarily, so we don't keep
  //      reprocessing the same first-page leading slugs every week
  //      while later slugs starve.
  //
  // ORDER BY translation_attempted_at asc nulls first prioritizes:
  //   never-attempted (NULL) → oldest attempts → newer attempts.
  // Combined with the 14-day filter, untouched slugs always come
  // first, and old retries cycle back through over time as JP
  // catalog growth makes new pairings possible.
  //
  // Stale-refresh (canonical row updated after pairing) is NOT
  // covered here on purpose — re-pairing already-paired EN cards
  // is an operator-driven concern.
  let candidateRows: EnRow[];
  try {
    const candidates = await sql.query(
      `
        select cc.slug,
               cc.canonical_name,
               cc.canonical_name_native,
               cc.card_number
          from canonical_cards cc
         where cc.language = 'EN'
           and cc.image_embedded_model_version = $1
           and not exists (
             select 1
               from card_translations ct
              where ct.en_slug = cc.slug
                and ct.rank = 0
           )
           and (
             cc.translation_attempted_at is null
             or cc.translation_attempted_at < now() - interval '14 days'
           )
         order by cc.translation_attempted_at asc nulls first, cc.slug asc
         limit $2
      `,
      [modelVersion, maxCards],
    );
    candidateRows = (candidates.rows ?? []) as EnRow[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `candidate query: ${message}` }, { status: 500 });
  }

  if (candidateRows.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      primary: 0,
      alts: 0,
      written: 0,
      last_slug: null,
      model_version: modelVersion,
      note: "no EN candidates",
    });
  }

  let processed = 0;
  let withPrimary = 0;
  let withAlts = 0;
  let written = 0;
  let lastSlug: string | null = null;
  // Track every slug we attempt, regardless of outcome. The post-loop
  // UPDATE stamps translation_attempted_at on all of them so the next
  // cron pass orders them after the still-untouched (NULL) slugs and
  // skips them entirely until the 14-day retry window opens. Slugs
  // that errored mid-flight are also stamped — better to retry them
  // in two weeks alongside the rest than monopolize next week's run.
  const attemptedSlugs: string[] = [];

  for (const row of candidateRows) {
    processed += 1;
    lastSlug = row.slug;
    attemptedSlugs.push(row.slug);
    try {
      const candidates = await findJpCandidates(row.slug, modelVersion, supabase);
      if (candidates.length > 0) {
        const pairings = pickPairings(row, candidates);
        if (pairings.length > 0) {
          if (pairings.some((p) => p.rank === 0)) withPrimary += 1;
          if (pairings.some((p) => p.rank > 0)) withAlts += 1;
          const rowsWritten = await upsertPairings(row.slug, pairings);
          written += rowsWritten;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-card-translations] ${row.slug} failed: ${message}`);
    }
  }

  // Batch-stamp the attempt timestamp. Single UPDATE keeps this off
  // the per-row hot path; passing the slugs as a text[] avoids
  // building a giant IN list. dbAdmin() uses the service role so the
  // RLS-protected column is writable.
  if (attemptedSlugs.length > 0) {
    const { error: stampErr } = await supabase
      .from("canonical_cards")
      .update({ translation_attempted_at: new Date().toISOString() })
      .in("slug", attemptedSlugs);
    if (stampErr) {
      console.warn(`[refresh-card-translations] stamp write-back failed: ${stampErr.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    primary: withPrimary,
    alts: withAlts,
    written,
    last_slug: lastSlug,
    max_cards: maxCards,
    model_version: modelVersion,
  });
}

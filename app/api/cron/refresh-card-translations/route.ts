/**
 * Cron: refresh-card-translations
 *
 * Weekly maintenance pass over the EN <-> JP card pairing junction
 * table (public.card_translations).
 *
 * Pairing algorithm (rule-based, NO embeddings):
 *
 *   For each EN canonical_card that's not yet paired:
 *     1. Look up its Scrydex set_code in card_printings.
 *     2. Query public.set_pair_map for the verified JP set_code paired
 *        with that EN set_code.
 *     3. Within that JP set, find a JP canonical_card whose
 *        canonical_name (case-insensitive) matches the EN card's.
 *     4. Exactly 1 match → write a card_translations row with
 *        source='set_pair', confidence=1.0, rank=0.
 *     5. 0 matches (EN-exclusive within paired set) or >1 matches
 *        (ambiguous, e.g. multiple same-name printings) → leave
 *        unpaired. Don't guess.
 *
 * Why we dropped the cosine matcher (PR #109's design): cross-language
 * SigLIP cosine on art crops produced a ~0.02 margin between same-art
 * and different-art same-Pokemon pairs — too thin for a global
 * threshold. The set-pair rule is precise by construction (Scrydex
 * curates the EN/JP set equivalence; we trust it) and trades coverage
 * for precision. See plans/we-need-to-work-cozy-shannon.md for the
 * calibration data driving this switch.
 *
 * Schedule: weekly Sunday 03:00 UTC. Long cadence is fine — set
 * pairings are static once written. The cron primarily exists to
 * pick up newly-imported canonical_cards rows (new sets, late JP
 * imports) without an operator running the backfill script.
 *
 * Trust: cron — bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import { hasVercelPostgresConfig } from "@/lib/ai/card-embeddings";
import {
  findPairBySetCode,
  deletePairingsForEnSlug,
  PAIRING_SOURCE,
  PAIRING_CONFIDENCE,
  PAIRING_RANK,
} from "@/lib/jp/translation-match.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MAX_CARDS = 500;
const MAX_CARDS_LIMIT = 5000;

type EnRow = {
  slug: string;
};

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

async function upsertPairing(enSlug: string, jpSlug: string): Promise<number> {
  // Drop any existing rows for this EN slug whose JP target differs
  // from the freshly-computed pair — same idempotency dance the
  // cosine matcher used. A rank=0 row flipping to a new jp_slug
  // would leave the old row behind on plain ON CONFLICT, breaking
  // the detail endpoint's .eq("rank", 0).maybeSingle() lookup.
  await sql.query(
    `delete from card_translations where en_slug = $1 and jp_slug <> $2`,
    [enSlug, jpSlug],
  );

  const result = await sql.query(
    `
      insert into card_translations
        (en_slug, jp_slug, confidence, rank, source, updated_at)
      values ($1, $2, $3, $4, $5, now())
      on conflict (en_slug, jp_slug) do update
        set confidence = excluded.confidence,
            rank       = excluded.rank,
            source     = excluded.source,
            updated_at = now()
    `,
    [enSlug, jpSlug, PAIRING_CONFIDENCE, PAIRING_RANK, PAIRING_SOURCE],
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
  const supabase = dbAdmin();

  // Candidate set: EN canonical_cards that haven't been attempted in
  // the last 14 days, ordered NULLS FIRST so never-tried slugs come
  // first. We process ALREADY-PAIRED slugs too — Codex P1 on
  // commit 4def09bc34 flagged that without re-validation, a stale
  // row from a prior matcher run (or from a since-changed catalog)
  // would outlive any picker verdict because the old candidate
  // filter `NOT EXISTS rank=0` skipped paired slugs forever. The
  // picker is idempotent + cheap, so re-running it on paired slugs
  // is safe and cleanups happen via deletePairingsForEnSlug below.
  let candidateRows: EnRow[];
  try {
    const candidates = await sql.query(
      `
        select cc.slug
          from canonical_cards cc
         where cc.language = 'EN'
           and (
             cc.translation_attempted_at is null
             or cc.translation_attempted_at < now() - interval '14 days'
           )
         order by cc.translation_attempted_at asc nulls first, cc.slug asc
         limit $1
      `,
      [maxCards],
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
      paired: 0,
      no_verified_set_pair: 0,
      no_name_match: 0,
      ambiguous: 0,
      written: 0,
      last_slug: null,
      note: "no EN candidates",
    });
  }

  let processed = 0;
  let paired = 0;
  let noPair = 0;
  let noMatch = 0;
  let ambiguous = 0;
  let written = 0;
  let staleDeleted = 0;
  let lastSlug: string | null = null;
  const attemptedSlugs: string[] = [];

  for (const row of candidateRows) {
    processed += 1;
    lastSlug = row.slug;
    attemptedSlugs.push(row.slug);
    try {
      const result = await findPairBySetCode(sql, row.slug);
      if (result.kind === "paired") {
        const rowsWritten = await upsertPairing(row.slug, result.jp_slug);
        written += rowsWritten;
        paired += 1;
      } else {
        // Non-paired verdict (unpaired or ambiguous) — drop any
        // existing rows for this EN slug so stale pairs from prior
        // matcher runs / catalog drift don't outlive the new verdict.
        // Codex P1 on commit 4def09bc34.
        const deleted = await deletePairingsForEnSlug(sql, row.slug);
        staleDeleted += deleted;
        if (result.kind === "unpaired" && result.reason === "no_verified_set_pair") {
          noPair += 1;
        } else if (result.kind === "unpaired" && result.reason === "no_name_match") {
          noMatch += 1;
        } else if (result.kind === "ambiguous") {
          ambiguous += 1;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-card-translations] ${row.slug} failed: ${message}`);
    }
  }

  // Stamp translation_attempted_at on every slug we processed so the
  // 14-day filter pushes them to the back of the queue next week.
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
    paired,
    no_verified_set_pair: noPair,
    no_name_match: noMatch,
    ambiguous,
    written,
    stale_deleted: staleDeleted,
    last_slug: lastSlug,
    max_cards: maxCards,
  });
}

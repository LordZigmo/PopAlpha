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
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";
import {
  findPairBySetCodeInCatalog,
  loadTranslationMatchCatalog,
  deletePairingsForEnSlug,
  upsertPrimaryPairing,
} from "@/lib/jp/translation-match.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_MAX_CARDS = 500;
const MAX_CARDS_LIMIT = 5000;
const PAGE_SIZE = 1000;
const STAMP_CHUNK_SIZE = 500;

type EnRow = {
  slug: string;
};

function parseMaxCards(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CARDS;
  return Math.min(parsed, MAX_CARDS_LIMIT);
}

async function loadCandidateRows(supabase: SupabaseClient, maxCards: number): Promise<EnRow[]> {
  const rows: EnRow[] = [];
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  let from = 0;

  while (rows.length < maxCards) {
    const pageSize = Math.min(PAGE_SIZE, maxCards - rows.length);
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .eq("language", "EN")
      .or(`translation_attempted_at.is.null,translation_attempted_at.lt.${cutoff}`)
      .order("translation_attempted_at", { ascending: true, nullsFirst: true })
      .order("slug", { ascending: true })
      .range(from, to)
      .returns<EnRow[]>();

    if (error) throw new Error(`candidate query: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function stampAttempted(supabase: SupabaseClient, attemptedSlugs: string[]): Promise<number> {
  const attemptedAt = new Date().toISOString();
  let stamped = 0;
  for (const chunk of chunks(attemptedSlugs, STAMP_CHUNK_SIZE)) {
    const { count, error } = await supabase
      .from("canonical_cards")
      .update({ translation_attempted_at: attemptedAt }, { count: "exact" })
      .in("slug", chunk);
    if (error) throw new Error(`canonical_cards stamp: ${error.message}`);
    stamped += count ?? 0;
  }
  return stamped;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

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
  let catalog;
  try {
    [candidateRows, catalog] = await Promise.all([
      loadCandidateRows(supabase, maxCards),
      loadTranslationMatchCatalog(supabase),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
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
      const result = findPairBySetCodeInCatalog(catalog, row.slug);
      if (result.kind === "paired") {
        const rowsWritten = await upsertPrimaryPairing(supabase, row.slug, result.jp_slug);
        written += rowsWritten;
        paired += 1;
      } else {
        // Non-paired verdict (unpaired or ambiguous) — drop any
        // existing rows for this EN slug so stale pairs from prior
        // matcher runs / catalog drift don't outlive the new verdict.
        // Codex P1 on commit 4def09bc34.
        const deleted = await deletePairingsForEnSlug(supabase, row.slug);
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
    try {
      await stampAttempted(supabase, attemptedSlugs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-card-translations] stamp write-back failed: ${message}`);
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

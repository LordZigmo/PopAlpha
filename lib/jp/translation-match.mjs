/**
 * EN <-> JP card-pairing logic.
 *
 * Shared by:
 *   - scripts/backfill-card-translations.mjs (manual bulk runs)
 *   - app/api/cron/refresh-card-translations/route.ts (weekly cron)
 *
 * Algorithm: rule-based set-pair join, no embeddings.
 *
 * Background: PR #109 tried cross-language SigLIP cosine over full-card
 * crops, then over art-only crops. Both produced a cross-language
 * same-art band of ~0.78–0.87 that overlapped the different-art-same-
 * Pokemon band by only ~0.02. A global threshold can't separate them
 * — same-art is reliably the top of its name-cohort but never with a
 * confident margin to nearest impostors. See plans/we-need-to-work-
 * cozy-shannon.md for the full diagnosis and calibration probe data.
 *
 * Replacement: Scrydex assigns set IDs per-language (EN `base1` =
 * Base Set, JP `base1_ja` = 拡張パック / Expansion Pack). For most
 * paired sets the `<id>` ↔ `<id>_ja` convention holds. The
 * `public.set_pair_map` table records every candidate pair plus the
 * auto-measured name-overlap percentage; only rows with verified=true
 * are trusted. Within a verified set pair, we pair an EN card to the
 * JP card whose canonical_name matches (case-insensitive). Exactly
 * one JP match → pair; zero or multiple → leave unpaired.
 *
 * Trade-off vs the visual approach:
 *   - Coverage: ~7,000-8,000 EN cards (vs 23k total). Sets without
 *     verified pairs in set_pair_map don't get a toggle. EN-exclusive
 *     sets (Celebrations, Crown Zenith) are the bulk of the miss.
 *     Operators can hand-add manual rows to set_pair_map to bridge
 *     reprint / bundled-set cases.
 *   - Precision: ~100%. Two cards that share a Scrydex-curated set
 *     pair AND a canonical_name are by definition the same card
 *     across language.
 *   - No ML, no thresholds, no recalibration when models update.
 *
 * Everything below is pure (no DB access). The caller (cron or script)
 * provides a @vercel/postgres `sql` client; this module returns the
 * SQL string + params or executes via the provided client.
 */

/**
 * Find the JP pair for a given EN canonical_slug using set_pair_map +
 * canonical_name equality. Returns one of:
 *
 *   { kind: "paired",     jp_slug, en_set_code, jp_set_code, en_set_name, jp_set_name }
 *   { kind: "unpaired",   reason: "no_verified_set_pair" }   — EN set has no
 *                                                              entry in set_pair_map
 *                                                              with verified=true
 *   { kind: "unpaired",   reason: "no_name_match", en_set_code, jp_set_code }
 *                                                            — EN card sits in a
 *                                                              paired set but no JP
 *                                                              card in the paired
 *                                                              set shares its name
 *   { kind: "ambiguous",  jp_slugs: [...], en_set_code, jp_set_code }
 *                                                            — multiple same-name
 *                                                              JP cards in the
 *                                                              paired set; refuse
 *                                                              to pick blindly
 *
 * `sqlClient` is the @vercel/postgres `sql` export (the script + the
 * cron both already import it). Pure JS so it's testable by injecting
 * a stub client.
 */
export async function findPairBySetCode(sqlClient, enSlug) {
  const { rows } = await sqlClient.query(
    `
      with en as (
        -- A canonical_card typically has multiple card_printings rows
        -- (HOLO + REVERSE_HOLO + NON_HOLO variants share the same
        -- canonical_slug). They almost always carry the same set_code,
        -- but we filter out NULLs and ORDER BY set_code so the LIMIT 1
        -- never silently flaps across runs. Codex P2 on PR #119.
        select cc.slug         as en_slug,
               cc.canonical_name,
               cp.set_code     as en_set_code
          from canonical_cards cc
          join card_printings cp on cp.canonical_slug = cc.slug
         where cc.slug = $1
           and cc.language = 'EN'
           and cp.set_code is not null
         order by cp.set_code
         limit 1
      ),
      pair as (
        select spm.jp_set_code, spm.en_set_name, spm.jp_set_name
          from en
          join set_pair_map spm on spm.en_set_code = en.en_set_code
         where spm.verified = true
      ),
      jp_matches as (
        select distinct cc.slug as jp_slug
          from en
          join pair on true
          join card_printings cp on cp.set_code = pair.jp_set_code
          join canonical_cards cc on cc.slug = cp.canonical_slug
         where cc.language = 'JP'
           and lower(trim(cc.canonical_name)) = lower(trim(en.canonical_name))
      )
      select
        (select en_set_code from en)              as en_set_code,
        (select jp_set_code from pair)            as jp_set_code,
        (select en_set_name from pair)            as en_set_name,
        (select jp_set_name from pair)            as jp_set_name,
        (select count(*) from pair)               as pair_count,
        (select count(*) from jp_matches)         as match_count,
        (select array_agg(jp_slug)
           from jp_matches)                       as jp_slugs
    `,
    [enSlug],
  );

  const r = rows[0] ?? {};
  const pairCount = Number(r.pair_count ?? 0);
  const matchCount = Number(r.match_count ?? 0);
  const jpSlugs = Array.isArray(r.jp_slugs) ? r.jp_slugs : [];

  if (pairCount === 0) {
    return { kind: "unpaired", reason: "no_verified_set_pair", en_set_code: r.en_set_code ?? null };
  }
  if (matchCount === 0) {
    return {
      kind: "unpaired",
      reason: "no_name_match",
      en_set_code: r.en_set_code,
      jp_set_code: r.jp_set_code,
    };
  }
  if (matchCount > 1) {
    return {
      kind: "ambiguous",
      jp_slugs: jpSlugs,
      en_set_code: r.en_set_code,
      jp_set_code: r.jp_set_code,
    };
  }
  return {
    kind: "paired",
    jp_slug: jpSlugs[0],
    en_set_code: r.en_set_code,
    jp_set_code: r.jp_set_code,
    en_set_name: r.en_set_name ?? null,
    jp_set_name: r.jp_set_name ?? null,
  };
}

/**
 * Confidence + source values written to card_translations for rule-based
 * pairings. Constants live here so the cron route and the backfill
 * script don't drift on the schema.
 *
 * confidence=1.0 because set-pair + name match is a definitional
 * equivalence, not a probabilistic guess. If we ever introduce
 * fuzzy bridging (e.g. base4 -> base1 via reprint chain) we can drop
 * confidence for those rows to e.g. 0.95.
 */
export const PAIRING_SOURCE = "set_pair";
export const PAIRING_CONFIDENCE = 1.0;
export const PAIRING_RANK = 0;

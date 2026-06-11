# Handoff: PSA SpecID → Catalog Mapping (Population Tables, Phase 2)

**Audience:** a fresh Claude session starting cold. Read `docs/ROADMAP.md`
first — this is Phase 2 of the Population Tables feature. Phase 1 (the
snapshot pipeline) is merged; your job is to connect its SpecID-keyed data
to our card catalog so population can ever render on a card page.

## The one-sentence task

Fill `psa_spec_targets.canonical_slug` — map each PSA SpecID to the
canonical card slug it represents — accurately enough that we would bet a
user-facing POP tab on it, and design the mapping so wrong matches are
detectable and reversible.

## Context you must internalize

1. **What a SpecID is.** PSA's internal ID for a card *spec* — one
   (set, card number, subject, variety) combination, e.g. "1995 POKEMON
   GYM CHALLENGE 29 SABRINA'S GENGAR HOLO". All certs of that spec share
   it, across all grades.
2. **Where our SpecIDs come from.** Every PSA cert lookup
   (`/api/psa/cert`, used by the slab scanner) returns a payload whose
   `PSACert` object carries `SpecID`, `Year`, `Brand` (≈ set name),
   `Category`, `CardNumber`, `Subject` (≈ card name), `Variety` (e.g.
   HOLO, 1ST EDITION). Targets accumulate in `psa_spec_targets`
   (migration `20260611213000_psa_spec_pop_snapshots.sql`): seeded from
   historic lookups in `psa_cert_cache.data->'raw'->'PSACert'` and
   `psa_cert_snapshots.raw->'PSACert'`, and grown by a harvest hook in
   `app/api/psa/cert/route.ts` (`harvestSpecTarget`). The `description`
   column is `Year Brand CardNumber Subject Variety` concatenated.
3. **What you're mapping INTO.** `canonical_cards` (slug pk,
   canonical_name, subject, set_name, year, card_number, language,
   variant) + `card_aliases` (alias → canonical_slug). Slugs are the
   app-wide card key. Cards also have printings/variants (finishes,
   editions) — a SpecID is often *finer* than a card (1st Edition Holo vs
   Unlimited are different specs for the same card) — see
   `docs/card-detail-variant-picker.md` and the printings model before
   deciding whether to map to slug only or slug + variant qualifier.
4. **House matching patterns.** We already run provider→catalog matching
   for Scrydex/PokemonTCG: see `lib/backfill/pokemontcg-normalized-match.ts`
   (normalization + match), `provider_card_map` (the analog mapping
   table), and `lib/backfill/matching-quality-audit.ts` (how we audit
   match quality). Follow these conventions; do not invent a parallel
   vocabulary.
5. **The data-trust bar.** This project had a pricing-freshness incident
   (2026-06-10) whose lesson is codified: green pipelines are not proof.
   A wrong slug mapping silently shows a user the WRONG card's population
   — worse than no data. Design for: confidence scoring, an unmatched/
   ambiguous queue, and spot-check verification against live PSA pages.

## Constraints

- **Additive only.** Do not modify existing pricing/matching tables or any
  launch surface. New columns on `psa_spec_targets` or a new mapping table
  are both acceptable (a dedicated `psa_spec_card_map` with
  `confidence`, `match_method`, `matched_at`, `verified` is probably the
  better shape — decide and document).
- **No PSA API spend.** Mapping uses data we already hold (descriptions on
  targets + cert payloads). The 100-call/day quota belongs to the snapshot
  cron + live scans.
- **Match key reality check.** PSA `Brand` strings are messy
  ("POKEMON GYM CHALLENGE", "POKEMON JAPANESE VS", category sometimes
  carries the game). Expect: a curated PSA-set-name → our-set mapping
  table as the backbone, then card_number + normalized subject within the
  set, with `Variety` resolving edition/finish. English first; JP sets
  exist in PSA's world ("JAPANESE" infix) and our catalog has language
  columns — handle or explicitly defer JP.
- **Migrations**: follow existing naming (`supabase/migrations/<ts>_*.sql`),
  RLS on for server-only tables, registered guardrails if you add routes
  (`lib/auth/route-registry.ts`, `scripts/security-guardrails.config.mjs`,
  `vercel.json` for crons). `npm run check:security:static` must pass.
- **Git**: feature branch, commit/push, PR — never push to main.

## Suggested shape (you may improve on it)

1. Inventory: dump current `psa_spec_targets` rows + descriptions; measure
   how many distinct PSA Brand strings exist. (Owner can run SQL for you
   in Supabase if the service key isn't available in your sandbox.)
2. Build the set-mapping backbone (PSA Brand → our set), seeded
   deterministically, with a review file the owner can eyeball.
3. Deterministic matcher: within mapped set, exact card_number + normalized
   subject ⇒ high confidence; fuzzy name ⇒ medium, queued for review;
   no set mapping ⇒ unmatched.
4. Persist with confidence + method; sync high-confidence slugs into
   `psa_spec_targets.canonical_slug`.
5. Audit artifact: a script/route reporting match-rate, confidence
   distribution, and N random samples for human spot-checks (mirror
   `matching-quality-audit.ts`).
6. Wire the harvest hook so NEW specs from scans attempt a match on
   arrival (best-effort, never blocking the lookup).

## Definition of done

- ≥90% of current targets either confidently matched or explicitly queued
  (no silent guesses), with the audit artifact proving it.
- The owner has spot-checked a random sample against psacard.com and PSA
  set pages.
- `docs/ROADMAP.md` Phase 2 row updated to `shipped` with a one-line
  pointer to the audit results.

## Verification environment notes

- The remote sandbox cannot reach popalpha.ai/Supabase/PSA directly; the
  owner runs authenticated curls/SQL from his Mac, and
  `mcp__Vercel__web_fetch_vercel_url` reaches public popalpha.ai routes.
- iOS builds are CI-verified (`ios-build` workflow); web typecheck via
  `npx tsc --noEmit`, lint via `npx eslint <files>`.

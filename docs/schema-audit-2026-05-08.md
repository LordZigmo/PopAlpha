# Schema Audit — 2026-05-08

## Context

Structured assessment of the current schema's identity, variant, language, pricing, and set models, with a 1–10 readiness rating for four candidate features (set indices, JP market, graded vs raw, cross-market arbitrage). Sourced from the migrations in `supabase/migrations/` (255 migrations as of 2026-05-08), with focus on the post-March 2026 canonical refactor and the in-flight Phase 2/3 printings work.

---

## Recommended next steps (prioritized)

1. **Rename `canonical_cards.variant` to `product_kind` for clarity** *(originally framed as "drop vestigial"; corrected 2026-05-08 after grep showed active use)*. The column is **not vestigial** — it holds `'SEALED'` to flag sealed products and is read in card-detail, search, match, and scan flows. Renaming clarifies that this is product-type, not card-variant. See §1.
2. **Promote `grade` from TEXT to FK against a `grade_definitions` catalog** — *small migration, big drift-prevention payoff*. Affects `price_snapshots`, `price_history`, `card_metrics`, `variant_metrics`. See §8 item 3.
3. **Ship the denser brief on existing `set_summary_snapshots` data** — *no schema work needed*. The set-level pipeline already produces market cap, momentum, heat score, and top movers per day; this is purely a frontend/API exposure task. See §5.
4. **Address the 5% multi-cohort slug residue** — *data work, not schema*. ~252k rows still need stamp/pattern/edition granularity beyond the current `finish` enum, primarily the HOLO pattern case. See §2 "Known residue."
5. **Promote `set_id` to a real `sets` table with FK** — *backend refactor, no user-visible change*. Replace `card_printings.set_code/set_name` with a FK and add era/release_date/language/total_count. See §8 item 1.

---

## 1. Card identity — logical vs printing

**Identity is two-axis: logical card and physical printing.**

- `canonical_cards` ([20260227123000_canonical_cards.sql:1](../supabase/migrations/20260227123000_canonical_cards.sql)) — the **logical** root. PK is `slug` (text). Columns: `canonical_name`, `subject`, `set_name`, `year`, `card_number`, `language`, `variant`, `created_at`.
- `card_printings` ([20260227190000_card_printings.sql:1](../supabase/migrations/20260227190000_card_printings.sql)) — the **physical** manifestation. PK is `id` (uuid). FK `canonical_slug` → `canonical_cards(slug)`. A single canonical card can have many printings.
- Unique constraint on `card_printings`: `(set_code, card_number, language, finish, edition, coalesce(stamp,''), coalesce(finish_detail,''))` — this is the de-facto "printing identity tuple."
- `card_aliases` and `printing_aliases` tables let provider tokens map into both layers.

**Correction (2026-05-08)**: an earlier draft of this audit called `canonical_cards.language` and `canonical_cards.variant` *vestigial*. They are not. Both are actively read in production:

- `canonical_cards.variant` carries product-kind semantics (`'SEALED'` flags sealed products: booster boxes, ETBs). Read in [lib/data/assets.ts:453](../lib/data/assets.ts) for the sealed-vs-card branch in card detail, plus canonical-match scoring ([app/api/canonical/match/route.ts:44](../app/api/canonical/match/route.ts)), search ranking, embedding generation, and scan-eval flows. The column name is misleading — it overloads with the printing-level variant concept (finish/edition/stamp) but actually means "product type." A rename to `product_kind` would clarify intent without dropping data.
- `canonical_cards.language` is the canonical-level language axis used for JP discovery. Filtered in the homepage Japanese rail ([lib/data/homepage.ts:353](../lib/data/homepage.ts)) and the `/data` page JP catalog tier summary ([lib/data/tier-summary.ts:126](../lib/data/tier-summary.ts)). It's denormalized from the printing layer (a card all of whose printings are JP is `language='JP'` here) but the denormalization is load-bearing for fast filtering.

Both columns predate the Phase-2 split, but the Phase-2 split absorbed only the **per-printing** axes (finish/edition/stamp/language) — these canonical-level columns were retained because they answer different questions (product type, primary language). They are not safe to drop.

**Note**: there is also a legacy `cards` table that was largely dropped in [20260301180000_cards_phase2_drop_cards.sql](../supabase/migrations/20260301180000_cards_phase2_drop_cards.sql), but its `canonical_slug` axis is preserved in [20260301160000_card_detail_identity_axis.sql:6](../supabase/migrations/20260301160000_card_detail_identity_axis.sql).

---

## 2. Variant representation

**Variants are decomposed into three independent dimensions, stored as columns on `card_printings`:**

- `finish` (CHECK constraint, 5 values): `NON_HOLO | HOLO | REVERSE_HOLO | ALT_HOLO | UNKNOWN` — [20260227190000_card_printings.sql:9](../supabase/migrations/20260227190000_card_printings.sql)
- `edition` (CHECK constraint, 3 values): `UNLIMITED | FIRST_EDITION | UNKNOWN` — [20260227190000_card_printings.sql:11](../supabase/migrations/20260227190000_card_printings.sql)
- `stamp` (nullable text, **unconstrained** — 40+ observed values): `SHADOWLESS`, `STAFF_STAMP`, `PRERELEASE`, `LEAGUE_1ST_PLACE`, ball-pattern stamps, etc. Phase 3a classifier in [20260423040000_phase3a_stamp_classifier_and_remap.sql](../supabase/migrations/20260423040000_phase3a_stamp_classifier_and_remap.sql).
- `finish_detail` (nullable text) — an additional axis added during Phase 2/3 to hold sub-variants of `finish` (e.g. specific holo patterns) without exploding the `finish` enum.
- Provider tokens are mapped via `label_normalization_rules` ([20260227203000_pokemontcg_cards_variants.sql:81](../supabase/migrations/20260227203000_pokemontcg_cards_variants.sql)) — priority-based regex matching from raw provider strings to the (finish, edition, stamp) tuple.

**Hardcoded business logic**: minimal. The slug-extension pattern `canonical_slug:finish:edition:stamp` ([20260423050000_phase3b_edition_classifier_and_remap.sql:268](../supabase/migrations/20260423050000_phase3b_edition_classifier_and_remap.sql)) is the closest to encoded variant identity, but it's a derived form, not the source of truth.

**Known residue**: ~5% of multi-cohort slugs (≈252k rows) still need stamp/pattern/edition granularity beyond what the current `finish` enum supports — primarily the HOLO pattern case (e.g. cosmos vs galaxy holo).

---

## 3. Language / region

**Language is a printing-level dimension.** Stored on `card_printings.language` (TEXT NOT NULL, **no enum constraint**, observed values: `EN`, `JP`, `unknown`). Participates in the printing unique index, so EN and JP versions of "same" card live as separate printings.

There's no `region` column distinct from language — there's a `set_code` and `set_name` on `card_printings`, but no first-class region/market field.

**Cardinality**: just EN/JP/unknown today. A new value (e.g. `KO`) requires no schema change — but also no validation, so typos drift in.

**To add JPY-priced data tomorrow**: nothing in the price tables would break — currency is already explicit (see §4). The blockers are catalog (the JP card universe is 377/23k slugs imported) and provider integrations, not schema.

---

## 4. Pricing model

**The pricing layer is a 4-table hierarchy, all keyed on `(canonical_slug, printing_id, grade)`:**

| Table | Granularity | Purpose |
| --- | --- | --- |
| `provider_ingests` ([20260301030000_internal_price_layer.sql:16](../supabase/migrations/20260301030000_internal_price_layer.sql)) | Per fetch event | Raw audit log, full `raw_payload` JSONB |
| `price_snapshots` ([20260301030000_internal_price_layer.sql:41](../supabase/migrations/20260301030000_internal_price_layer.sql)) | Per observation | Provider-agnostic normalized prices |
| `price_history` ([20260301010000_price_history.sql:11](../supabase/migrations/20260301010000_price_history.sql)) | Per day | Permanent daily median rollup, used for charts/portfolio P&L |
| `card_metrics` ([20260301030000_internal_price_layer.sql:75](../supabase/migrations/20260301030000_internal_price_layer.sql)) | Latest per (slug, printing, grade) | Precomputed analytics — what the frontend reads |

**Multiple price series for one card**: yes. The `(canonical_slug, printing_id, grade)` triple is a first-class key. `RAW` and `10` and `9_5` (or `PSA9`/`PSA10` in `holdings`) for the same card live in separate rows simultaneously.

**Time resolution**:
- `price_snapshots.observed_at` is per-event (provider call resolution — minutes to hours)
- `price_history` is daily, populated by `snapshot_price_history()` cron at 6am ([20260301010000_price_history.sql:41](../supabase/migrations/20260301010000_price_history.sql))
- A separate hourly refresh exists for `card_metrics` momentum

**Currency**: explicit on every row — `currency TEXT NOT NULL DEFAULT 'USD'`. Adding JPY rows requires no schema change. The ingest layer normalizes to USD via `convertToUsd()`, but multiple currencies *can* be stored.

**Grade**: first-class TEXT dimension. Default `'RAW'`. The actual taxonomy varies by table:

- `variant_metrics` enforces a CHECK constraint allowing `RAW | LE_7 | G8 | G9 | G9_5 | G10 | G10_PERFECT | 7_OR_LESS | 8 | 9 | 9_5 | 10 | 10_PERFECT` ([20260416000000_downsample_price_history.sql:178](../supabase/migrations/20260416000000_downsample_price_history.sql)) — note the same logical grade has both a G-prefix and a bucket-form synonym, an artifact of the variant-ref normalizer.
- `price_snapshots`, `price_history`, `card_metrics`, `tracked_assets` all use `grade TEXT NOT NULL DEFAULT 'RAW'` with **no CHECK** — drift-prone but in practice writes flow through the same normalizer.
- `holdings.grade` is the most drift-prone surface — `app/api/holdings/route.ts:49` accepts any trimmed string, and the UI sends `PSA9`/`PSA10` (no underscore) per `app/portfolio/PortfolioClient.tsx:40`.

The PR 1 grade catalog at [supabase/migrations/20260508120000_grade_definitions_catalog.sql](../supabase/migrations/20260508120000_grade_definitions_catalog.sql) enumerates these as canonical codes plus aliases for the G-prefix synonyms.

**Conditions (raw NM/LP/MP/HP/DMG)**: a **separate table** `card_condition_prices` ([20260415120000_card_condition_prices.sql:8](../supabase/migrations/20260415120000_card_condition_prices.sql)), CHECK-constrained on `condition`. Condition is modeled separately from `grade` — `grade='RAW'` rows in price_snapshots don't carry condition; condition lives in its own table.

---

## 5. Sets / grouping

**There is no curated `sets` table.** Sets are referenced as `set_code` and `set_name` (text) on `card_printings`. A `canonical_set_catalog` view aggregates printings by `(set_name, year)` ([20260303200000_canonical_set_catalog_view.sql](../supabase/migrations/20260303200000_canonical_set_catalog_view.sql)).

For provider mapping, `provider_set_map` ([20260301070000_provider_set_map.sql:11](../supabase/migrations/20260301070000_provider_set_map.sql)) maps `(provider, canonical_set_code)` → `provider_set_id` with a confidence score.

**Set-level indices already exist** (the work is further along than the question implies):

- `set_finish_summary_latest` ([20260302110000_set_summary_pipeline.sql:135](../supabase/migrations/20260302110000_set_summary_pipeline.sql)) — current market cap + 7d/30d change per `(set_id, finish)`
- `set_summary_snapshots` ([20260302110000_set_summary_pipeline.sql:150](../supabase/migrations/20260302110000_set_summary_pipeline.sql)) — daily snapshots per `(set_id, as_of_date)` with `market_cap`, `change_7d_pct`, `change_30d_pct`, `heat_score`, `breakout_count`, `value_zone_count`, `top_movers_json`, `top_losers_json`
- `set_id` is computed via `normalize_set_id(set_name)` — a slug derived from the set name, **not** a real PK

**Population data, float estimates**: not present. PSA cert tables (`psa_cert_lookup_cache`, `psa_cert_snapshots`) hold individual cert lookups, not aggregated pop reports. `card_metrics.scarcity_adjusted_value` exists with the comment `-- reserved for future PSA pop multiplier` ([20260301030000_internal_price_layer.sql:92](../supabase/migrations/20260301030000_internal_price_layer.sql)).

**No higher groupings** (era, block, archetype). One card belongs to one set. There is no `card_groupings` table.

---

## 6. Cross-market & grading readiness

**EN ↔ JP equivalence**: not modeled. There is **no** `parallel_card_id`, `equivalent_card_id`, or `card_family_id`. Today the only way to find the JP equivalent of an EN card is name + set heuristic. The query is brittle and would silently miss cards with non-trivial JP-EN name differences.

**Raw vs PSA 10 query today**: trivial — one query against `price_history` filtered on grade. The dimension is first-class.

**Grading EV inputs — what exists vs what's net-new**:

| Input | Status | Where |
| --- | --- | --- |
| Raw price | exists | `price_history.median_price` where `grade='RAW'` |
| Graded prices by tier | exists | same table, different grade values |
| Grading fee config | net-new | nothing in schema |
| PSA gem rate (% at 10) | net-new | individual certs are cached but not aggregated by grade |
| Population data | net-new | requires a new `psa_population` table |

**Multi-TCG support**: not generalized. The schema is Pokémon-only. There is no `tcg_id` or `game_id` column on canonical_cards or sets.

---

## 7. Honest 1–10 readiness ratings

| Feature | Score | Why | Biggest refactor needed |
| --- | --- | --- | --- |
| **(a) Set-level indices** | **7/10** | Already largely built. `set_summary_snapshots` ships market_cap, momentum, heat_score, top movers per set per day. | Promote `set_id` from a derived slug to a real `sets` table with FK on `card_printings.set_id`. Add era/block/release_date/language/total_count. |
| **(b) JP market alongside EN** | **5/10** | Schema is JP-tolerant (language column, currency-agnostic prices, no `_jp` columns) but lacks cross-language linkage and curated JP catalog (377/23k). | Add `card_family_id` (or `parallel_canonical_slug`) so EN/JP siblings link explicitly, then ingest a JP catalog source. The schema work is small; the data work is the bulk. |
| **(c) Graded vs raw price comparison** | **8/10** | Grade is first-class on every price table. Frontend query is trivial. | Mostly a data problem — grade as TEXT drifts. Promote to a `grade_definitions` catalog table with FK + add structured graded-price ingestion (eBay sold + GoldenAuctioneer + etc.). |
| **(d) Cross-market arbitrage (JP raw → EN PSA 10)** | **3/10** | Currency, grade, and printing axes exist, but the *connections* are missing: no EN↔JP linkage, no PSA population, no grading fee config, no arbitrage signal table. | Layered: needs (a) cross-language linking, (b) PSA population ingest, (c) grading fee config, (d) an `arbitrage_signals` table with the spread/EV computation. This is genuinely net-new work, not a refactor. |

---

## 8. Greenfield: what to change starting today

If the schema were rebuilt knowing the four features above are the destination, the changes are mostly *new tables* on top of a sound core, plus a few cleanups to remove vestigial state.

**New tables (net additions):**

1. **`sets`** — real PK table. Columns: `set_id` (slug PK), `set_name`, `language`, `era`, `release_date`, `total_card_count`, `parent_set_id` (for sub-sets). Replace `card_printings.set_code/set_name` with `set_id` FK. Existing `set_summary_snapshots` and `set_finish_summary_latest` join on the FK.
2. **`card_families`** — links logical cards across languages. Columns: `family_id` (uuid PK), `display_name`, `family_type` ('translation', 'reprint', etc.). Add `family_id` (nullable) FK on `canonical_cards`. Now the JP equivalent of an EN card is one join, with referential integrity.
3. **`grade_definitions`** — catalog of grader+tier combos. Columns: `grade_id` (PK), `grader` ('PSA','BGS','CGC'), `tier` (10, 9.5, 9, ...), `is_half_grade`, `display_name`. Replace `grade TEXT` with `grade_id` FK on `price_snapshots`, `price_history`, `card_metrics`, `variant_metrics`. Eliminates string drift.
4. **`grading_fees`** — `(grader, service_tier, fee_usd, turnaround_days, effective_from, effective_to)`. EV calculations stop being app-side magic numbers.
5. **`psa_population`** — `(canonical_slug, printing_id, grade_id, population, gem_rate, reported_at)`. Daily/weekly sync from PSA pop reports. Powers gem-rate × graded price → grading EV.
6. **`stamp_definitions`** — promote the 40+ free-text stamp values into a catalog with a FK. Same drift problem as `grade`, same fix.
7. **`arbitrage_signals`** — `(family_id, source_market, target_market, source_grade_id, target_grade_id, spread_usd, ev_usd, computed_at)`. The "JP raw → EN PSA 10" view becomes a query against this table, not a fanout join.

**Cleanups (vestigial state):**

8. Rename `canonical_cards.variant` → `product_kind` (or similar). Per the §1 correction, this column is *not* vestigial — it holds `'SEALED'` to flag sealed products and is read across card-detail, search, match, and scan flows. The current name overloads with the printing-level variant concept, which is the actual confusion source; a rename eliminates the confusion without dropping data. `canonical_cards.language` is correctly named and serves as the canonical-level JP filter; consider adding a CHECK constraint (`'EN' | 'JP' | 'unknown'`) but leave the column.
9. Standardize on `printing_id` — phase out `variant_ref TEXT` in `variant_metrics`/`variant_price_latest`/`variant_signals_latest`. The dual-key (`variant_ref` text + `printing_id` uuid) is mid-migration residue from before printings existed; keeping both costs index space and confuses queries.
10. Add a `tcg_id` axis to `sets` and `canonical_cards`. Cheap to add now while Pokémon is the only TCG; expensive once a second game is real.

**Don't change:**

- The 4-tier price layer (`provider_ingests` → `price_snapshots` → `price_history` → `card_metrics`) is sound — provider-agnostic, time-resolution-flexible, currency-explicit. It's the part of the schema most ready for the future.
- The (canonical_slug, printing_id, grade) key on every price table — already correct.
- The provider-decoupled ingestion (`provider_ingests` JSONB raw + `provider_set_map`) — already correct shape for adding JP providers.

# RLS Readiness

PopAlpha is moving to a database-first authorization model:

- `dbPublic()` is only for anonymous/public data and explicitly public views.
- `createServerSupabaseUserClient()` is the default for authenticated user flows.
- `dbAdmin()` is reserved for server-only admin, cron, ingest, and debug paths.
- Clerk user IDs are the canonical owner identity for app-owned rows.

Verified on 2026-03-18 against the linked Supabase project:

- `public` schema tables: `61`
- `public` tables with RLS enabled before this pass: `4`
- `supabase/config.toml` had Clerk third-party auth disabled
- active code still referenced deprecated Clerk `template: "supabase"` guidance
- user-owned tables still had broad `anon` / `authenticated` grants in the live DB

The matrix below captures the verified pre-hardening baseline and the intended end state. The "Phase 1 status" table records the objects that are now implemented and live after this pass.

## Ownership Conventions

- Use `clerk_user_id text` when the row is the user's canonical identity row.
- Use `owner_clerk_id text` when the row is owned by a user but is not the identity row itself.
- Use `voter_id text`, `follower_id text`, or similar relationship keys only when the column meaning is directional and product-specific.
- Prefer `DEFAULT public.requesting_clerk_user_id()` on user-owned insert columns when the row should default to the signed-in Clerk subject.
- Every column referenced by RLS must have an index that matches the policy predicate.

## Client Rules

| Route kind | Allowed DB client | Notes |
| --- | --- | --- |
| Public anonymous read | `dbPublic()` | Only against explicitly public tables/views/functions |
| Authenticated user flow | `createServerSupabaseUserClient()` | Database authorization first, app validation second |
| Admin / cron / ingest / debug | `dbAdmin()` | Server-only, narrow, reviewed call sites only |

## Security Matrix

| Object | Type | Current | Current route/client usage | Class | Current risk | Target access model | Required migrations / route changes | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `app_users` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Owner key: clerk_user_id text` | `/api/me`, `/api/settings`, `/api/onboarding/handle`, `/api/profile`, `/api/profile/banner` via `lib/data/app-user.ts` and `dbAdmin()` today | user-owned identity | Service-role bypass for normal user flows; broad direct table access if called through API; stale docs encourage wrong client | Authenticated users can `SELECT/INSERT/UPDATE` only their own row via Clerk `sub`; no anon access; public profile discovery goes through safe views/functions only | Enable RLS; add Clerk-sub helper function; tighten grants; move `lib/data/app-user.ts` to `dbUser`; add handle RPCs; keep `public_user_profiles` as safe projection | Phase 1 |
| `holdings` | table | `RLS: yes`<br>`Policies: stale auth.uid() = user_id`<br>`Grants: anon/auth broad DML`<br>`Owner key: owner_clerk_id text + legacy user_id uuid` | `/api/holdings`, `/api/holdings/summary` via `dbAdmin()` today | user-owned | Live policies do not match live ownership column; broad grants; service-role bypass in user routes | Authenticated users can `SELECT/INSERT/UPDATE/DELETE` only their own rows keyed by `owner_clerk_id = auth.jwt()->>'sub'`; no anon access | Replace UUID policies; default/index `owner_clerk_id`; keep legacy `user_id` for compatibility only; move routes to `dbUser` | Phase 1 |
| `private_sales` | table | `RLS: no`<br>`Stale policies exist for owner_id uuid`<br>`Grants: anon/auth broad DML`<br>`Owner key: legacy owner_id uuid only` | `/api/private-sales`, `/api/private-sales/[id]` via `dbPublic()` today | user-owned | No live RLS; ownership column is wrong type for Clerk; route-level filters are primary control | Authenticated users can `SELECT/INSERT/DELETE` only their own rows keyed by `owner_clerk_id text`; no anon access | Add `owner_clerk_id text`; index + default; replace stale UUID policies; tighten grants; move routes to `dbUser` | Phase 1 |
| `profile_posts` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Owner key: owner_id text` | `/api/profile`, `/api/profile/posts`, `/api/profile/posts/[id]` via `dbPublic()` today | user-owned + public projection | Public-schema table is fully open; route-level owner checks are primary control | Authenticated owner can manage own posts; public reads go through `public_profile_posts` only | Enable RLS; grant auth-only base access; keep public reads on view; move routes to `dbUser` | Phase 1 |
| `profile_follows` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Identity: follower_id text / followee_id text` | `/api/profile/follow`, `/api/community-pulse`, homepage/card pulse helpers via `dbPublic()` today | user-owned relationship | Any API caller can mutate relationships today if route mistakes occur; raw table is over-granted | Authenticated users can insert/delete as `follower_id = sub`; select only rows they need; public counts come from safe view | Enable RLS; authenticated-only grants; move route and user helpers to `dbUser`; public stats stay on projection view | Phase 1 |
| `profile_post_card_mentions` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Identity: derives from post_id -> profile_posts.owner_id` | `/api/profile`, `/api/profile/posts`, `/api/profile/posts/[id]` via `dbPublic()` today | user-owned dependent table | Mentions can be inserted/deleted outside post ownership if a route is wrong | Authenticated users can manage mentions only for their own posts; public reads go through safe view only | Enable RLS with `EXISTS` owner check; auth-only grants; keep public reads on view | Phase 1 |
| `push_subscriptions` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Owner key: clerk_user_id text` | `/api/me/push`, `/api/me/push/test` via `dbAdmin()` today | user-owned | Service-role bypass in normal user flows; broad base-table access | Authenticated users can `SELECT/INSERT/UPDATE/DELETE` only their own subscriptions; no anon access | Enable RLS; default/index owner column; tighten grants; move routes to `dbUser` | Phase 1 |
| `community_card_votes` | table | `RLS: no`<br>`Grants: anon/auth broad DML`<br>`Owner key: voter_id text` | `/api/community-pulse`, `/api/holdings/summary`, homepage/card helpers, `/api/community-pulse/crowd`, `/api/market-signals` via `dbPublic()` today | user-owned social signal | Raw vote rows and voter IDs are over-exposed; public routes read base table directly | Authenticated users can insert own votes and read only own/followee raw rows; public aggregate access goes through a dedicated view | Enable RLS; add aggregate public view; make follow/feed views security-invoker; move user flows to `dbUser`; move public routes to aggregate view | Phase 1 |
| `community_user_vote_weeks` | view | `RLS: n/a`<br>`reloptions: NULL`<br>`Grants: broad by default` | `/api/community-pulse` via `dbPublic()` today | authenticated derived view | View is in exposed schema and does not explicitly honor base RLS | Authenticated-only `SELECT`; `security_invoker` so it obeys `community_card_votes` policies | Recreate / alter with `security_invoker`; revoke broad grants; query via `dbUser` | Phase 1 |
| `community_vote_feed_events` | view | `RLS: n/a`<br>`reloptions: NULL`<br>`Grants: broad by default` | `/api/community-pulse` via `dbPublic()` today | authenticated derived view | Same as above; currently based on fully open table | Authenticated-only `SELECT`; `security_invoker`; rows limited by base-table RLS | Recreate / alter with `security_invoker`; revoke broad grants; query via `dbUser` | Phase 1 |
| `public_community_vote_totals` | view | `Absent before this pass` | Needed by public crowd / signal / homepage aggregate reads | public read | Public routes currently hit raw vote table | Anonymous/authenticated `SELECT` on aggregate counts only, no voter IDs | Create view; route public aggregate reads through it; grant `SELECT` only | Phase 1 |
| `waitlist_signups` | table | `RLS: yes`<br>`Grants: INSERT only for anon/authenticated`<br>`Identity: optional clerk_user_id text` | `/api/waitlist` via `dbPublic()` for anon and `createServerSupabaseUserClient()` for authenticated users | write-only public | Phase 2.4 enabled RLS and restricted inserts to the intended public contract | Write-only public insert-only path, no public select of submissions; duplicate `(email_normalized, desired_tier)` submissions are accepted as a no-op in route code | Keep insert-only grants and enforce `clerk_user_id` through authenticated RLS, not route trust | Implemented in Phase 2.4 |
| `ebay_deletion_notification_receipts` | table | `Absent before this pass` | `/api/ebay/deletion-notification` via `dbAdmin()` after verified signature only | internal service-only | Without an internal receipt store, any future webhook processing would be tempted to mix verification and destructive work inline | Verified-only quarantine table with no anon/auth grants; only server-side ingest/admin workers can read or process receipts | Create internal receipt table with unique `notification_id`; enable RLS; keep grants empty; insert only after successful eBay signature verification | Phase 2 |
| `ebay_deletion_manual_review_tasks` | table | `Absent before this pass` | `/api/cron/process-ebay-deletion-receipts` and `/api/admin/ebay-deletion-tasks*` via `dbAdmin()` | internal service-only | Verified receipts need a safe downstream target before any destructive workflow exists | Internal-only normalized task table for manual review; no anon/auth grants; one task per receipt; review-state changes stay internal only | Create internal task table with unique `receipt_id` / `notification_id`; add explicit review-state metadata; keep server-only access for worker + admin review routes only | Phase 2 |
| `ebay_deletion_manual_review_events` | table | `Absent before this pass` | `/api/admin/ebay-deletion-tasks/[id]` via audited internal update path only | internal service-only | Mutable review state without append-only history would make future deletion design unauditable | Internal-only append-only audit log for every meaningful operator mutation on a manual-review task | Create internal audit-events table; enable RLS; keep grants empty; write only through a narrow server-only update path | Phase 2 |
| `canonical_cards` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated`<br>`Identity: slug text` | Search, card pages, homepage, profile mentions, canonical match route via `dbPublic()` | public read | Phase 2.5 enabled RLS while preserving the public catalog contract | Keep anon/auth `SELECT`; revoke write-oriented grants; no user-scoped writes | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `card_printings` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | Card pages, holdings summary, set pages via `dbPublic()` | public read | Phase 2.5 enabled RLS without breaking direct public reads | Keep anon/auth `SELECT`; revoke extra grants | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `card_aliases` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | Search / canonicalization paths via `dbPublic()` | public read | Phase 2.5 enabled RLS without widening the search contract | Keep public `SELECT`; revoke extra grants | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `card_profiles` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | `/api/card-profiles` via `dbPublic()` | public read | Phase 2.5 enabled RLS while preserving the card-profile read path | Keep public `SELECT`; revoke extra grants | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `deck_cards` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | Search, card pages, homepage, and deck/profile helpers via `dbPublic()` | public read | Phase 2.5 enabled RLS on a direct public read table instead of relying on grant-only exposure | Keep anon/auth `SELECT`; no public writes | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `fx_rates` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | Pricing/fx helpers via `dbPublic()` | public read | Phase 2.5 enabled RLS while preserving public FX reads | Keep anon/auth `SELECT`; no public writes | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `printing_aliases` | table | `RLS: yes`<br>`Grants: SELECT only for anon/authenticated` | Search / canonicalization helpers via `dbPublic()` | public read | Phase 2.5 enabled RLS on alias lookups without changing the public contract | Keep anon/auth `SELECT`; no public writes | Keep explicit public-read policies and SELECT-only grants | Implemented in Phase 2.5 |
| `card_metrics` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_card_metrics`; should not be the public contract | internal read-model base | Phase 2.6 moved the public contract fully onto `public_card_metrics` and removed direct base-table access | Public reads through `public_card_metrics`; direct table access limited | Keep RLS enabled with no public policies; keep admin/cron writes only | Implemented in Phase 2.6 |
| `variant_metrics` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_variant_metrics` | internal read-model base | Phase 2.6 removed direct public access while preserving the public view contract | Public reads through `public_variant_metrics`; direct base access limited | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `price_history` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal base for `public_price_history` refresh/snapshot paths | internal read-model base | Phase 2.6 removed direct public access while preserving the public history view | Public reads through `public_price_history`; direct base access limited | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `price_history_points` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_price_history` | internal read-model base | Phase 2.6 removed direct public access from the raw history-point table | Public reads through `public_price_history`; direct base access limited | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `market_latest` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_market_latest` | internal read-model base | Phase 2.6 moved the public market-latest contract onto the view only | Public reads through view only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `set_summary_snapshots` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_set_summaries` | internal read-model base | Phase 2.6 removed direct public access while preserving the summary view | Public reads through view only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `set_finish_summary_latest` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_set_finish_summary` | internal read-model base | Phase 2.6 removed direct public access while preserving the finish-summary view | Public reads through view only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `psa_cert_snapshots` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_psa_snapshots` | public read base / view-backed | Phase 2.6 moved public PSA history reads onto the `public_psa_snapshots` view only | Keep public read via view; reduce direct base writes | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `variant_price_daily` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal derived price rollup backing public set/market projections | internal read-model base | Phase 2.6 removed direct public access from the derived daily variant rollup | Public reads stay on approved views only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `variant_price_latest` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal latest-price rollup backing public set/market projections | internal read-model base | Phase 2.6 removed direct public access from the latest variant rollup | Public reads stay on approved views only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `variant_sentiment_latest` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal derived sentiment rollup | internal read-model base | Phase 2.6 removed direct public access from the latest sentiment rollup | Public reads stay on approved views only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `variant_signals_latest` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal derived signals rollup | internal read-model base | Phase 2.6 removed direct public access from the latest signals rollup | Public reads stay on approved views only | Keep RLS enabled with no public policies | Implemented in Phase 2.6 |
| `card_page_views` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Backing table for `public_card_page_view_daily` and `public_card_page_view_totals`; write route is `/api/cards/[slug]/view` via `dbAdmin()` | write-only public + aggregate public read | Phase 2.4 enabled RLS and kept the raw event table internal-only | Public writes only through `/api/cards/[slug]/view` with a server-only insert path; public reads through aggregate views | Keep raw table internal-only and do not restore public RPC execute | Implemented in Phase 2.4 |
| `public_card_metrics` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Homepage, cards, assets, freshness, holdings summary via `dbPublic()` | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | Anonymous/authenticated `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_variant_metrics` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Card pages, homepage, assets | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_price_history` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Card pages, homepage, freshness, assets | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_market_latest` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Market snapshot / related pages | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_set_summaries` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Set pages | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_set_finish_summary` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Set pages | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_psa_snapshots` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | PSA activity route | public read | Phase 3.2 finalized the read-only grant contract on the public PSA view | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_variant_movers` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Homepage/assets | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_variant_movers_priced` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Holdings summary/homepage | public read | Phase 3.2 finalized the read-only grant contract on the public view surface | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_card_page_view_daily` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Card live-activity and market-signals | public read | Phase 3.2 finalized the read-only grant contract on the telemetry aggregate view | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_card_page_view_totals` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | Card live-activity and market-signals | public read | Phase 3.2 finalized the read-only grant contract on the telemetry aggregate view | `SELECT` only | Keep `SELECT`-only grants and no direct write privileges | Implemented in Phase 3.2 |
| `public_user_profiles` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | `/u/[handle]` page | public read | Public profile projection is implemented and Phase 3.2 finalized the view grant surface | Public read-only projection of visible profiles | Keep `SELECT`-only grants; profile visibility remains enforced in the view definition | Implemented in Phase 1; grants finalized in Phase 3.2 |
| `public_profile_posts` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | `/u/[handle]` page | public read | Public-profile post filtering is implemented and Phase 3.2 finalized the view grant surface | Public read-only projection of posts for public profiles only | Keep `SELECT`-only grants and filtered view definition | Implemented in Phase 1; grants finalized in Phase 3.2 |
| `public_profile_social_stats` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | `/u/[handle]` page, `/api/profile` currently | mixed public/read-model | Visibility filtering is implemented and Phase 3.2 finalized the view grant surface | Public read-only stats for public profiles; own-profile stats from base tables with `dbUser` | Keep `SELECT`-only grants and filtered view definition | Implemented in Phase 1; grants finalized in Phase 3.2 |
| `public_profile_post_mentions` | view | `reloptions: NULL`<br>`Grants: SELECT only for anon/authenticated` | `/u/[handle]` page | public read | Public mention filtering is implemented and Phase 3.2 finalized the view grant surface | Public read-only mentions for posts on public profiles only | Keep `SELECT`-only grants and filtered view definition | Implemented in Phase 1; grants finalized in Phase 3.2 |
| `pro_card_metrics` | view | `reloptions: NULL`<br>`Grants: none for anon/authenticated` | `/api/pro/signals` via `dbAdmin()` | internal/paywalled | Phase 3.2 removed direct public grants from the paywalled view surface | No anon/auth direct grants; server-only admin access or explicit paid-user path later | Keep paywalled/internal view access off anon/authenticated | Implemented in Phase 3.2 |
| `pro_variant_metrics` | view | `reloptions: NULL`<br>`Grants: none for anon/authenticated` | `/api/pro/signals` via `dbAdmin()` | internal/paywalled | Phase 3.2 removed direct public grants from the paywalled view surface | No anon/auth direct grants; server-only admin access or explicit paid-user path later | Keep paywalled/internal view access off anon/authenticated | Implemented in Phase 3.2 |
| `ingest_runs` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Cron / ingest paths via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access; service-only | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `label_normalization_rules` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Provider normalization/admin repair flows via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access; service-only | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_ingests` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Cron / ingest paths via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access; service-only | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `pipeline_jobs` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Cron worker queue via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access; service-only | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `provider_raw_payloads` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Ingest / debug via `dbAdmin()` | internal service-only | Raw provider payloads should never be public; Phase 2.2 enabled RLS | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_raw_payload_lineages` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Ingest / debug via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_normalized_observations` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Ingest / metrics refresh via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_observation_matches` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Matching/debug routes via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_card_map` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Matching/import flows via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_set_map` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Pipeline/import flows via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `provider_set_health` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Debug/pipeline health via `dbAdmin()` | internal service-only | Phase 2.2 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.2 |
| `psa_cert_cache` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | PSA cert route cache via `dbAdmin()` | internal service-only | Phase 2.3 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.3 |
| `psa_cert_lookup_logs` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | PSA lookup logging via `dbAdmin()` | internal service-only | Phase 2.3 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.3 |
| `psa_certificates` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | PSA ingest/admin seed flows via `dbAdmin()` | internal service-only | Phase 2.3 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.3 |
| `psa_seed_certs` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Admin PSA seed management and ingest via `dbAdmin()` | internal service-only | Phase 2.3 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.3 |
| `realized_sales_backtest_snapshots` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Internal market confidence backtest snapshots | internal service-only | Phase 2.3 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.3 |
| `tracked_assets` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Debug/admin tracked-assets routes via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `tracked_refresh_diagnostics` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Debug routes via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `matching_quality_audits` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Cron/debug via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `outlier_excluded_points` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Cron/debug via `dbAdmin()` | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.1 |
| `pricing_transparency_snapshots` | table | `RLS: yes`<br>`Policy: public read`<br>`Grants: SELECT only for anon/authenticated` | Debug/transparency capture via `dbAdmin()`; no user route should write directly | public read + internal write | Phase 3.1 reasserted the read-only public contract on the live table grants | Anonymous/authenticated `SELECT` only; writes via service-only | Keep RLS state and SELECT-only grants; internal writes stay on `dbAdmin()` / service role | Implemented in Phase 3.1 |
| `canonical_raw_provider_parity` | table | `RLS: yes`<br>`Policy: public read`<br>`Grants: SELECT only for anon/authenticated` | Card page via `dbPublic()` | public read + internal write | Phase 3.1 reasserted the read-only public contract on the live table grants | Anonymous/authenticated `SELECT` only; writes via service-only | Keep RLS state and SELECT-only grants; internal writes stay on `dbAdmin()` / service role | Implemented in Phase 3.1 |
| `market_snapshots` | table | `RLS: yes`<br>`Policy: public read`<br>`Grants: SELECT only for anon/authenticated` | Market snapshot route via `dbPublic()` | public read + internal write | Phase 3.1 reasserted the read-only public contract on the live table grants | Anonymous/authenticated `SELECT` only; writes via service-only | Keep RLS state and SELECT-only grants; internal writes stay on `dbAdmin()` / service role | Implemented in Phase 3.1 |
| `card_embeddings` | table | `RLS: yes`<br>`Grants: none for anon/authenticated` | Embedding refresh via cron/admin | internal service-only | Phase 2.1 enabled RLS and removed direct public access | No anon/auth access | Keep service-only and add no public policies | Implemented in Phase 2.1 |

## Phase 1 Status

| Object | Status after this pass | Evidence |
| --- | --- | --- |
| `app_users` | Implemented | RLS enabled; authenticated `SELECT/INSERT/UPDATE` only; self policies use `clerk_user_id = requesting_clerk_user_id()`; `lib/data/app-user.ts` now uses `createServerSupabaseUserClient()` |
| `holdings` | Implemented | RLS enabled with `owner_clerk_id` policies for `SELECT/INSERT/UPDATE/DELETE`; authenticated-only grants; `/api/holdings` and `/api/holdings/summary` now use `createServerSupabaseUserClient()` |
| `private_sales` | Implemented | Added `owner_clerk_id text` with default + indexes; RLS enabled with owner policies for `SELECT/INSERT/DELETE`; authenticated-only grants; private-sales routes now use `createServerSupabaseUserClient()` |
| `profile_posts` | Implemented | RLS enabled with self policies on `owner_id`; authenticated-only base-table grants; public reads moved to filtered `public_profile_posts` |
| `profile_follows` | Implemented | RLS enabled with self/followee visibility rules; authenticated-only grants; `/api/profile/follow` and community helpers now use `createServerSupabaseUserClient()` |
| `profile_post_card_mentions` | Implemented | RLS enabled with `EXISTS` checks through owned posts; authenticated-only grants; public reads use filtered `public_profile_post_mentions` |
| `push_subscriptions` | Implemented | RLS enabled with self policies on `clerk_user_id`; authenticated-only grants; `/api/me/push` and `/api/me/push/test` no longer use `dbAdmin()` |
| `community_card_votes` | Implemented | RLS enabled with self insert + own/followee read policies; authenticated `SELECT/INSERT` only; user flows now use `createServerSupabaseUserClient()` |
| `community_user_vote_weeks` | Implemented | Recreated with `security_invoker = true`; authenticated `SELECT` only; queried through `createServerSupabaseUserClient()` |
| `community_vote_feed_events` | Implemented | Recreated with `security_invoker = true`; authenticated `SELECT` only; queried through `createServerSupabaseUserClient()` |
| `public_community_vote_totals` | Implemented | New aggregate public view exposes counts only; anon/authenticated `SELECT`; public crowd/signal routes use it instead of raw votes |
| `public_user_profiles` | Implemented | Recreated as filtered public projection for `profile_visibility = 'PUBLIC'`; anon/authenticated `SELECT` only |
| `public_profile_posts` | Implemented | Recreated as filtered public projection for public profiles only; anon/authenticated `SELECT` only |
| `public_profile_social_stats` | Implemented | Recreated as filtered public projection without leaking `clerk_user_id`; own-profile route now computes from base tables via `createServerSupabaseUserClient()` |
| `public_profile_post_mentions` | Implemented | Recreated as filtered public projection for mentions on public profiles only; anon/authenticated `SELECT` only |
| Guardrails | Implemented | `supabase/config.toml` enables Clerk third-party auth; `scripts/check-dbadmin-imports.mjs` blocks service-role leakage; default privileges migration locks down new public-schema objects; `scripts/verify-phase1-rls.mjs` proves anon/user A/user B/admin behavior |

## Phase 2 Status

| Object | Status after this pass | Evidence |
| --- | --- | --- |
| `Phase 2.1 internal operational tables` | Implemented | `card_embeddings`, `card_external_mappings`, `deck_aliases`, `decks`, `ingest_runs`, `listing_observations`, `market_events`, `market_observations`, `matching_quality_audits`, `outlier_excluded_points`, `pipeline_jobs`, `price_snapshots`, `pricing_alert_events`, `tracked_assets`, and `tracked_refresh_diagnostics` now have RLS enabled with no anon/authenticated policies; `scripts/verify-phase1-rls.mjs` proves anon/authenticated cannot read them |
| `Phase 2.2 provider and mapping tables` | Implemented | `label_normalization_rules`, `provider_card_map`, `provider_ingests`, `provider_normalized_observations`, `provider_observation_matches`, `provider_raw_payload_lineages`, `provider_raw_payloads`, `provider_set_health`, and `provider_set_map` now have RLS enabled with no anon/authenticated policies; `scripts/verify-phase1-rls.mjs` proves anon/authenticated cannot read them |
| `Phase 2.3 reference and PSA internal tables` | Implemented | `psa_cert_cache`, `psa_cert_lookup_logs`, `psa_certificates`, `psa_seed_certs`, and `realized_sales_backtest_snapshots` now have RLS enabled with no anon/authenticated policies; `scripts/verify-phase1-rls.mjs` proves anon/authenticated cannot read them |
| `Phase 2.4 public write tables` | Implemented | `waitlist_signups` now has insert-only public RLS policies and `card_page_views` now has RLS with no anon/authenticated policies; `scripts/verify-phase1-rls.mjs` proves waitlist insert semantics still work while direct reads stay blocked |
| `Phase 2.5 direct public-read tables` | Implemented | `canonical_cards`, `card_aliases`, `card_printings`, `card_profiles`, `deck_cards`, `fx_rates`, and `printing_aliases` now have RLS enabled with explicit anon/authenticated `SELECT` policies and SELECT-only grants; `scripts/verify-phase1-rls.mjs` proves anonymous reads still work across the full batch |
| `Phase 2.6 internal base tables behind public views` | Implemented | `card_metrics`, `market_latest`, `price_history`, `price_history_points`, `psa_cert_snapshots`, `set_finish_summary_latest`, `set_summary_snapshots`, `variant_metrics`, `variant_price_daily`, `variant_price_latest`, `variant_sentiment_latest`, and `variant_signals_latest` now have RLS enabled with no anon/authenticated policies; `scripts/verify-phase1-rls.mjs` proves direct reads stay blocked while the `public_*` views remain readable |

## Phase 3 Status

| Object | Status after this pass | Evidence |
| --- | --- | --- |
| `Phase 3.1 existing RLS public/internal-write tables` | Implemented | `canonical_raw_provider_parity`, `market_snapshots`, and `pricing_transparency_snapshots` now explicitly reassert SELECT-only anon/authenticated grants while keeping their existing public-read RLS policies; `scripts/verify-phase1-rls.mjs` proves public reads still work and direct public writes remain blocked |
| `Phase 3.2 view and paywalled surface cleanup` | Implemented | `canonical_set_catalog` and the `public_*` views now explicitly reassert SELECT-only anon/authenticated grants, `community_user_vote_weeks` and `community_vote_feed_events` remain authenticated SELECT-only, and `market_snapshot_rollups`, `pro_card_metrics`, and `pro_variant_metrics` now explicitly revoke anon/authenticated access; `scripts/verify-phase1-rls.mjs` proves the grant split holds |

## Legacy Data Findings

- `private_sales` still has one legacy row (`id = ea79fc1b-f697-4336-b57b-50e575215cb8`, `cert = 99138296`) where both `owner_id` and `owner_clerk_id` are `NULL`.
- There is no trustworthy Clerk mapping for that row in the repo or the live `app_users` schema, so it cannot be backfilled automatically.
- Under the new Phase 1 policies that row is intentionally invisible to user-scoped clients until an admin assigns a real `owner_clerk_id` or removes the orphaned row.

## Exact Phase 2 / 3 Rollout Sequence

- The machine-readable source of truth for the remaining RLS rollout is `RLS_ROLLOUT_BATCHES` in `scripts/security-guardrails.config.mjs`.
- Apply these in order. Do not collapse them into one global public-schema RLS migration.

### Phase 2.1 - Internal Operational Tables

- Status: Implemented

- Migration name:
  - `phase2_internal_operational_tables_rls`
- Tables:
  - `card_embeddings`
  - `card_external_mappings`
  - `deck_aliases`
  - `decks`
  - `ingest_runs`
  - `listing_observations`
  - `market_events`
  - `market_observations`
  - `matching_quality_audits`
  - `outlier_excluded_points`
  - `pipeline_jobs`
  - `price_snapshots`
  - `pricing_alert_events`
  - `tracked_assets`
  - `tracked_refresh_diagnostics`
- Migration rule:
  - enable RLS
  - revoke all `anon` / `authenticated` table grants
  - add no `anon` / `authenticated` policies
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - linked verification now proves `anon` / `authenticated` cannot `SELECT` these tables

### Phase 2.2 - Provider And Mapping Tables

- Status: Implemented

- Migration name:
  - `phase2_provider_and_mapping_tables_rls`
- Tables:
  - `label_normalization_rules`
  - `provider_card_map`
  - `provider_ingests`
  - `provider_normalized_observations`
  - `provider_observation_matches`
  - `provider_raw_payload_lineages`
  - `provider_raw_payloads`
  - `provider_set_health`
  - `provider_set_map`
- Migration rule:
  - enable RLS
  - revoke all `anon` / `authenticated` table grants
  - add no `anon` / `authenticated` policies
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - linked verification now proves `anon` / `authenticated` cannot `SELECT` these tables

### Phase 2.3 - Reference And PSA Internal Tables

- Status: Implemented

- Migration name:
  - `phase2_reference_and_psa_internal_tables_rls`
- Tables:
  - `psa_cert_cache`
  - `psa_cert_lookup_logs`
  - `psa_certificates`
  - `psa_seed_certs`
  - `realized_sales_backtest_snapshots`
- Migration rule:
  - enable RLS
  - revoke all `anon` / `authenticated` table grants
  - add no `anon` / `authenticated` policies
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - linked verification now proves `anon` / `authenticated` cannot `SELECT` these tables

### Phase 2.4 - Public Write Tables

- Status: Implemented

- Migration name:
  - `phase2_public_write_tables_rls`
- Tables:
  - `waitlist_signups`
  - `card_page_views`
- Migration rule:
  - enable RLS on both
  - `waitlist_signups`: keep write-only contract with `INSERT` policies for `anon` / `authenticated` and no public `SELECT` / `UPDATE` / `DELETE`
  - `card_page_views`: keep internal-only, with no public policies because writes already happen through the server-only route path
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - waitlist insert semantics still work and duplicate no-op behavior stays intact
  - direct public `SELECT` still fails on both tables

### Phase 2.5 - Direct Public Read Tables

- Status: Implemented

- Migration name:
  - `phase2_direct_public_read_tables_rls`
- Tables:
  - `canonical_cards`
  - `card_aliases`
  - `card_printings`
  - `card_profiles`
  - `deck_cards`
  - `fx_rates`
  - `printing_aliases`
- Migration rule:
  - enable RLS
  - add explicit `SELECT` policies for `anon` and `authenticated`, typically `USING (true)`
  - keep write grants revoked
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - anon catalog/search/card reads still work across all seven tables
  - insert/update/delete remain blocked by the SELECT-only grant contract

### Phase 2.6 - Internal Base Tables Behind Public Views

- Status: Implemented

- Migration name:
  - `phase2_internal_bases_backing_public_views_rls`
- Tables:
  - `card_metrics`
  - `market_latest`
  - `price_history`
  - `price_history_points`
  - `psa_cert_snapshots`
  - `set_finish_summary_latest`
  - `set_summary_snapshots`
  - `variant_metrics`
  - `variant_price_daily`
  - `variant_price_latest`
  - `variant_sentiment_latest`
  - `variant_signals_latest`
- Migration rule:
  - enable RLS
  - revoke direct `anon` / `authenticated` base-table grants
  - add no base-table public policies unless a view genuinely needs caller-scoped access
  - keep the public contract on the `public_*` views only
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - `public_card_metrics`, `public_price_history`, `public_market_latest`, `public_psa_snapshots`, `public_set_summaries`, `public_set_finish_summary`, `public_variant_metrics`, `public_variant_movers`, and `public_variant_movers_priced` still satisfy their anon `SELECT` contract

### Phase 3.1 - Existing RLS Public/Internal-Write Tables

- Status: Implemented

- Migration name:
  - `phase3_existing_rls_public_internal_write_grant_cleanup`
- Tables:
  - `canonical_raw_provider_parity`
  - `market_snapshots`
  - `pricing_transparency_snapshots`
- Migration rule:
  - do not change `rowsecurity`
  - tighten grants so `anon` / `authenticated` stay `SELECT`-only
  - keep internal writes on `dbAdmin()` / service-only paths
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - public reads still work
  - no direct public writes remain

### Phase 3.2 - View And Paywalled Surface Cleanup

- Status: Implemented

- Objects:
  - `pro_card_metrics`
  - `pro_variant_metrics`
  - all `public_*` views already intended to be `SELECT`-only
  - `canonical_set_catalog`
  - `community_user_vote_weeks`
  - `community_vote_feed_events`
  - `market_snapshot_rollups`
- Migration rule:
  - keep this as grant/view cleanup, not table RLS work
  - revoke any non-`SELECT` public grants from the public views
  - keep paywalled/internal views off `anon` / `authenticated`
- Verify:
  - `npm run check:security:schema:local`
  - `npm run verify:rls`
  - public and authenticated-only views keep their intended read contracts
  - paywalled/internal views stay off `anon` / `authenticated`
  - any user-facing pro route still works only through server-side entitlement checks

### Companion Repo Updates Per Batch

- For each batch:
  - move the tables from `RLS_EXEMPT_PUBLIC_TABLES` to `RLS_REQUIRED_PUBLIC_TABLES`
  - update `PUBLIC_SELECT_ONLY_OBJECTS`, `WRITE_ONLY_PUBLIC_OBJECT_GRANTS`, and `INTERNAL_NO_GRANT_OBJECTS` if the contract changes
  - add linked verification coverage if the new RLS state changes observable behavior
  - run `npm run check:security`
  - run `npm run verify:rls` when the batch changes public/user-visible row behavior

## Current Contract Hardening

- Public/read-model objects now use explicit current-object grants instead of relying on default privileges alone:
  - `canonical_cards`, `card_printings`, `card_aliases`, `card_profiles`, `canonical_set_catalog`, `printing_aliases`, `fx_rates`, `market_snapshots`, `pricing_transparency_snapshots`, `deck_cards`, and the `public_*` read-model views are `SELECT`-only where appropriate.
  - `community_user_vote_weeks` and `community_vote_feed_events` remain authenticated `SELECT`-only and retain `security_invoker`.
- Write-only public objects are narrowed:
  - `waitlist_signups` is now write-only for `anon` / `authenticated` (`INSERT` only plus sequence `USAGE`), with no direct read/delete grants.
  - `card_page_views` stays behind `/api/cards/[slug]/view` with a server-only insert path; public execute on `record_card_page_view(text)` is revoked.
- Internet-facing webhook handling now fails closed and quarantines verified deliveries:
  - `/api/ebay/deletion-notification` verifies the raw request body against eBay's signed `X-EBAY-SIGNATURE` envelope before any trusted work happens.
  - verified notifications insert a minimal receipt into `public.ebay_deletion_notification_receipts`; duplicates dedupe on `notification_id`; unverified requests never write or trigger deletion workflows.
- Internal receipt processing is now explicit and still non-destructive:
  - `/api/cron/process-ebay-deletion-receipts` claims verified receipts in small batches, normalizes the stored payload again, and creates one `public.ebay_deletion_manual_review_tasks` row per receipt.
  - the worker is idempotent: if the manual-review task already exists, the receipt still settles to `processed` instead of retrying forever.
- Internal manual review is now explicit and still non-destructive:
  - `/api/admin/ebay-deletion-tasks` lists normalized manual-review tasks with receipt-processing metadata and advisory exact-handle match context only.
  - `/api/admin/ebay-deletion-tasks/[id]` reads one task, returns append-only audit events, and allows only review-state / review-notes / advisory candidate-match updates.
  - all operator mutations now flow through an append-only audit trail instead of silent in-place history.
- Internal/provider/paywalled/debug objects now revoke `anon` / `authenticated` access directly on the existing objects, including `provider_*`, `pipeline_jobs`, `price_history_points`, `card_metrics`, `variant_metrics`, `pro_*`, `tracked_*`, `matching_quality_audits`, and related operational tables.
- Callable helper and RPC functions are locked down explicitly:
  - public-facing: `is_handle_available(text)`, `resolve_profile_handle(text)`, and `requesting_clerk_user_id()`
  - internal-only: refresh, snapshot, queue, and parity functions now revoke `anon` / `authenticated` execute privileges.
- An event trigger now auto-enables RLS for newly created `public` tables so exposed-schema tables do not silently ship without row security.

## Public Write Inventory

| Surface | Auth model | Write type | Current abuse controls | Current DB contract | Recommended action |
| --- | --- | --- | --- | --- | --- |
| `POST /api/waitlist` | anon + authenticated browser | insert-only signup | IP burst limiter, actor/email/tier limiter, honeypot, form-age check, structured logging | `public.waitlist_signups` `INSERT` only; no direct read/update/delete | Keep as-is; if semantics change, add a waitlist-specific server interface rather than broadening grants |
| `POST /api/cards/[slug]/view` | anon + authenticated browser | append-only telemetry | IP burst limiter, IP+slug limiter, cross-site fetch screening, structured logging | Server-only insert into `public.card_page_views`; raw table remains internal | Keep as-is; do not re-expose public execute on `record_card_page_view(text)` |
| `POST /api/ebay/deletion-notification` | webhook / internet-facing | verified receipt quarantine | eBay JWS verification on raw body, IP burst limiter, structured logging, receipt dedupe by `notificationId` | Server-only insert into `public.ebay_deletion_notification_receipts` after verified signature; no public DB writes | Keep quarantine-first; if deletion processing is added later, consume verified receipts from an internal worker rather than deleting inline in the route |
| `GET /api/cron/process-ebay-deletion-receipts` | internal cron/admin only | verified receipt consumer | cron auth, server-only `dbAdmin()`, idempotent receipt claiming, structured JSON run summary | Claims rows from `public.ebay_deletion_notification_receipts`; inserts normalized rows into `public.ebay_deletion_manual_review_tasks`; no public DB access | Keep internal-only; do not expose outside `CRON_ROUTES`; keep manual-review-only until a reviewed deletion workflow exists |
| `public.record_card_page_view(text)` | internal only | append-only telemetry function | `SECURITY DEFINER`, pinned `search_path`, no anon/authenticated execute | No public execute; route no longer depends on the function | Keep revoked from `anon` / `authenticated`; if a server path needs it later, call it with admin-only access |

## Enforced Guardrails

- Security invariants:
  - UI-backed internal admin routes must use the trusted internal-admin session model, never `ADMIN_SECRET`, as their normal auth path.
  - Every public write route, debug route, admin route, and cron route must be explicitly classified in the route registry and the trust-contract config.
  - Every security-sensitive operational script must be explicitly classified in the script trust contract.
  - User-facing routes must not use `dbAdmin()` unless they are explicitly allowlisted server-only exceptions.
  - Public callable functions, public table/view grants, and public sequence privileges must match the explicit contract config.
  - Public-schema tables must stay explicitly classified for RLS, and required `security_invoker` views must keep that behavior.
- One-command verification:
  - `npm run check:security:invariants`
  - this orchestrates route coverage, internal-admin page safety, admin/cron trust contracts, debug trust contracts, public write contracts, operational script trust contracts, the `dbAdmin()` guard, and the linked Supabase schema contract
  - `npm run check:security` is strict locally and in CI; if the linked schema prerequisites are missing, it fails with an explicit bootstrap message instead of reporting a soft skip
  - `npm run check:security:doctor` verifies the local linked-schema prerequisites before you run the full invariants path
  - `npm run check:security:schema:local` runs just the linked schema contract with `.env.local`, using the linked pooler URL in `supabase/.temp/pooler-url` plus `SUPABASE_DB_PASSWORD`
  - `npm run verify:rls:linked` remains the complementary behavior check for live row visibility and ownership semantics
- Before merging sensitive auth/route/database changes:
  - run `npm run check:security:doctor` once per machine or workspace setup change
  - run `npm run check:security:invariants`
  - run `npm run verify:rls:linked` when the change touches RLS behavior or linked-schema policy outcomes
  - update `scripts/security-guardrails.config.mjs`, `lib/auth/route-registry.ts`, and this document together when a trust boundary changes

- Static checks now fail the repo build if:
  - an `app/api/**/route.ts` file is missing classification in `lib/auth/route-registry.ts`
  - a file under `app/internal/admin/**` becomes a client component, imports `dbAdmin()`, or directly fetches outside the approved internal review admin route surface
  - a `public` or `ingest` route exports `POST` / `PUT` / `PATCH` / `DELETE` without an explicit `PUBLIC_WRITE_ROUTE_CONTRACTS` entry
  - a security-sensitive script under `scripts/` lacks an explicit `OPERATIONAL_SCRIPT_TRUST_CONTRACTS` entry, or its actual trust signals drift from that contract
  - a privileged non-route entrypoint outside `app/api/**` and `scripts/**` lacks an explicit contract entry, or its trust signals drift from the contract
  - a repo-owned callable function contract drifts from the explicit public function allowlist
  - `dbAdmin()` appears in a public route, user-scoped route, client module, or unapproved server helper
- Live schema checks now fail against the linked Supabase project if:
  - a `public` table is missing an explicit RLS classification or a required `rowsecurity = true` state
  - a `public` table/view drifts from its anon/authenticated grant contract
  - a `public` sequence is unclassified or drifts from its anon/authenticated privilege contract
  - an app-defined `public` function exposes `EXECUTE` to `anon` or `authenticated` outside the explicit allowlist
  - a `SECURITY DEFINER` app-defined `public` function loses its pinned `search_path`
  - `community_user_vote_weeks` or `community_vote_feed_events` loses `security_invoker = true`
  - the `popalpha_auto_enable_public_table_rls` event trigger disappears
- The repo-owned callable-function allowlist is intentionally narrow:
  - `is_handle_available(text)` -> `anon`, `authenticated`
  - `resolve_profile_handle(text)` -> `authenticated`
  - `requesting_clerk_user_id()` -> `authenticated`
- The function allowlist covers app-defined functions in `public`. Supabase-managed extension functions are excluded from this repo-owned contract because they are not introduced or versioned by PopAlpha migrations.
- `dbAdmin()` is allowed only in:
  - `app/api/admin/**`
  - `app/api/cron/**`
  - `app/api/debug/**`
  - `app/api/ingest/**`
  - `app/api/cards/[slug]/view/route.ts` as the one public-write exception, because it inserts into the internal `card_page_views` table without re-exposing a public RPC
  - `app/api/market/observe/route.ts`
  - `app/api/psa/cert/route.ts`
  - `lib/backfill/**`
  - `scripts/**`

## Operational Script Trust

- The machine-enforced source of truth is `OPERATIONAL_SCRIPT_TRUST_CONTRACTS` in `scripts/security-guardrails.config.mjs`.
- `npm run check:script-trust` fails if a security-sensitive script is unclassified, if its actual trust signals drift from the contract, or if the contract claims service-role usage that the script does not actually perform.
- The contract currently covers four broad classes:
  - linked-schema/bootstrap scripts: `scripts/check-linked-db-prereqs.mjs`, `scripts/check-supabase-security.mjs`, `scripts/verify-phase1-rls.mjs`
  - manual admin route drivers: `scripts/import-all-scrydex-canonical.mjs`, `scripts/import-all-pokemontcg-canonical.mjs`, `scripts/import-pokemontcg.ps1`
  - manual cron/debug route drivers and hybrids: `scripts/backfill-unpriced-sets.mjs`, `scripts/run-live-normalizer-smoke.mjs`, `scripts/sweep-justtcg-finish-repair.mjs`, plus a few explicitly marked deprecated legacy JustTCG drivers
  - direct service-role maintenance/report/diagnostic scripts: backfills, reports, diagnostics, and repair helpers that create a Supabase service-role client directly
- Legacy scripts that still target the retired `sync-justtcg-prices` flow are explicitly marked `deprecated` in the contract instead of being treated as current operational paths.
- Add a new operational script safely:
  1. Decide whether it truly needs to be a script, or whether the work belongs in a shared server module or an existing internal route.
  2. Minimize its trust inputs: prefer one narrow secret or one direct service-role client, not hybrid auth unless the job truly needs both.
  3. Add the script entry to `OPERATIONAL_SCRIPT_TRUST_CONTRACTS` with `classification`, `executionMode`, `requiredTrustInputs`, `expectedSignals`, and `usesServiceRole`.
  4. Run `npm run check:script-trust` and `npm run check:security`.
- Route vs script rule of thumb:
  - use a route when the job needs a real network boundary or scheduler target
  - use a script when the operator is running privileged maintenance directly from a local shell
  - use a shared server module when multiple routes or scripts need the same privileged implementation logic
  - `app/api/pro/signals/route.ts` as the one explicit user-facing exception, because it reads paywalled server-only projections after entitlement checks

## Privileged Entrypoints

- The machine-enforced non-route inventory lives in `scripts/security-guardrails.config.mjs`:
  - `INTERNAL_ADMIN_UI_ENTRYPOINT_CONTRACTS`
  - `AUTH_GLUE_ENTRYPOINT_CONTRACTS`
  - `PRIVILEGED_PACKAGE_SCRIPT_CONTRACTS`
  - `PRIVILEGED_WORKFLOW_CONTRACTS`
- `npm run check:privileged-entrypoints` fails if:
  - a new `app/internal/admin/**` page/layout/action appears without classification
  - a new sensitive `lib/auth/**` file or `proxy.ts` trust surface appears without classification
  - a secret-bearing GitHub workflow appears without classification
  - a privileged package-script wrapper drifts from its expected target command
- Current perimeter covered by that contract:
  - internal admin UI: `app/internal/admin/page.tsx`, `app/internal/admin/sign-in/page.tsx`, `app/internal/admin/actions.ts`, `app/internal/admin/(protected)/layout.tsx`, `app/internal/admin/(protected)/ebay-deletion-tasks/page.tsx`, `app/internal/admin/(protected)/ebay-deletion-tasks/actions.ts`
  - auth/middleware glue: `proxy.ts`, `lib/auth/clerk-enabled.ts`, `lib/auth/context.ts`, `lib/auth/require.ts`, `lib/auth/internal-admin-session-core.ts`, `lib/auth/internal-admin-session.ts`, `lib/auth/route-registry.ts`
  - privileged package scripts: `check:security`, `check:security:doctor`, `check:security:invariants`, `check:security:schema`, `check:security:schema:local`, `verify:rls`, `verify:rls:linked`, `ebay:deletion-setup`, `env:pull-safe`, `sets:backfill-summaries`, `import:pokemontcg-all`, `import:scrydex-all`, `import:scrydex-missing-printings`, `report:set-efficiency`, `justtcg:repair-sweep`, `justtcg:backfill-live`, `watch:unknown-finishes`, `ai:refresh-embeddings`
  - workflows: `.github/workflows/ci.yml`, `.github/workflows/psa-ingest-cron.yml`, `.github/workflows/supabase-migrations.yml`
- Add a new privileged entrypoint safely:
  1. Decide whether it is really an entrypoint or just a shared helper that should stay behind an existing entrypoint.
  2. Add it to the right contract map with the intended caller, trust model, and required trust inputs.
  3. Keep the implementation explicit: no hardcoded secrets, no hidden route bridges, no vague debug-only shortcuts.
  4. Run `npm run check:privileged-entrypoints` and `npm run check:security`.
- To intentionally expose a new public function safely:
  1. Create the function with an explicit `search_path` if it is `SECURITY DEFINER`.
  2. Grant `EXECUTE` only to the exact roles that need it.
  3. Add the exact signature to `scripts/security-guardrails.config.mjs`.
  4. Add or extend a verification case in `scripts/verify-phase1-rls.mjs` or the relevant feature test.
  5. Update this document if the public contract changed.
- To add a new public table safely:
  1. Decide whether it needs RLS or is a justified exempt read-model/internal table.
  2. Add it to the explicit RLS contract in `scripts/security-guardrails.config.mjs`.
  3. Add its anon/authenticated grant contract in the same config file.
  4. If it uses a `serial` / `bigserial` / identity-backed sequence, add that sequence to the explicit sequence contract and grant only the minimum required privilege, usually `USAGE`.
  5. Add or update verification coverage before the route ships.
- Sequence rules:
  - sequence privileges are checked separately from table grants because they can drift independently
  - insertable authenticated tables should usually grant only `USAGE` to `authenticated`
  - write-only public tables should grant only `USAGE` to the exact caller roles that insert rows
  - internal/admin/debug/provider sequences should not grant `USAGE`, `SELECT`, or `UPDATE` to `anon` or `authenticated`
- Waitlist contract:
  - `waitlist_signups` uses an insert-only helper behind `/api/waitlist`
  - duplicate submissions for the same normalized email + tier are accepted as an idempotent no-op in route code
  - the public route rate-limits burst traffic per IP and repeated submissions per actor + normalized email + tier before touching Supabase
  - the pricing modal sends a hidden `website` honeypot field and form-start timestamp; suspected bot traffic is rejected at the route layer without broadening table privileges
  - route logs are structured under `[public-write]` with `surface = "waitlist_signup"`, hashed IP/email identifiers, and explicit outcomes: `inserted`, `duplicate_noop`, `validation_failed`, `suspected_abuse`, `throttled`, and `error`
  - failure modes stay explicit: validation and suspected bot submissions return `400`, throttled traffic returns `429` with `Retry-After`, and duplicate no-op submissions still return `200`
  - we do not use table `upsert()` because it conflicts with the least-privilege write-only contract and would force broader table privileges than we want
  - if future product work needs merge/update semantics, add a narrowly scoped waitlist-specific RPC rather than reopening broad table grants
  - if future product work changes the waitlist UI fields, keep the anti-abuse checks and public-write tests aligned instead of weakening the table contract
- eBay deletion webhook contract:
  - `GET /api/ebay/deletion-notification` still serves the eBay challenge-response handshake using `EBAY_VERIFICATION_TOKEN`
  - `POST /api/ebay/deletion-notification` is unauthenticated by session but cryptographically verified using the Base64-encoded `X-EBAY-SIGNATURE` envelope, the raw request body bytes, and the eBay Notification API public key lookup for the advertised `kid`
  - eBay notification public keys are cached in memory by `baseUrl + kid` for `60` minutes, with a small bounded cache size, to avoid repeated upstream lookups for the same active key without turning verification into a persistent trust store
  - stale keys are never served after TTL expiry; if the key is missing from cache and a fresh lookup fails, the route still fails closed with no receipt insert
  - failure modes stay explicit and fail closed: missing signature headers return `400`, malformed signature or payload material returns `400`, signature/public-key mismatches return `412`, throttled traffic returns `429`, and transient verification infrastructure failures return `503`
  - verified deliveries only persist a quarantine receipt row in `public.ebay_deletion_notification_receipts`; the route does not perform destructive deletes or trusted state changes directly
  - receipt rows dedupe on `notification_id` so eBay retries are acknowledged without re-triggering internal work
  - route logs are structured under `[public-write]` with `surface = "ebay_deletion_notification"`, hashed request identifiers, and explicit outcomes: `accepted_verified`, `accepted_verified_duplicate`, `rejected_missing_headers`, `rejected_bad_signature`, `rejected_malformed`, `throttled`, and `error`
  - never log raw payloads, raw signatures, or raw eBay identifiers; only log hashed identifiers and verification metadata like `kid`, algorithm, digest, and payload hash fragments
- eBay receipt worker contract:
  - receipt processing uses a narrow state machine on `public.ebay_deletion_notification_receipts`: `received` -> `processing` -> `processed` or `failed`
  - `attempt_count`, `processing_started_at`, `failed_at`, `last_error_code`, and `last_error_summary` are recorded on the receipt row for retries and auditability
  - stale `processing` claims are automatically reclaimed back into `failed` by the claim function before the next batch is claimed
  - `processed` currently means exactly one thing in this phase: a normalized row exists, or already existed, in `public.ebay_deletion_manual_review_tasks`
  - the worker does not delete app data, erase users, or trigger downstream destructive actions; it only creates manual-review tasks from already verified receipts
  - the worker route is locked to `CRON_ROUTES`, and `check:route-coverage` now fails if it drifts out of the `cron` classification
- eBay manual review contract:
  - manual-review task states are internal only: `pending_review`, `needs_more_context`, `matched_candidate`, `no_match_found`, `escalated`
  - `/api/admin/ebay-deletion-tasks` and `/api/admin/ebay-deletion-tasks/[id]` are admin-only routes for inspecting normalized tasks, verified receipt metadata, advisory matching context, and append-only audit events
  - `/internal/admin/sign-in` now requires an authenticated Clerk operator plus an explicit internal admin allowlist in `INTERNAL_ADMIN_CLERK_USER_IDS` and/or `INTERNAL_ADMIN_EMAILS`; it issues a short-lived, signed, HttpOnly session cookie scoped only to `/internal/admin`
  - `/internal/admin/ebay-deletion-tasks` is a server-rendered internal page that reads through the existing admin JSON routes and only submits review-state, review-notes, and advisory candidate-match updates through those same routes
  - those review routes no longer use `ADMIN_SECRET` for UI-driven requests; the page layer forwards the current request cookies, and the route layer re-validates the internal admin session plus current Clerk-backed allowlist before serving data or accepting review mutations
  - internal review pages must stay mutation-light and server-only; no client-side unauthenticated fetch pattern or direct `dbAdmin()` usage is allowed in the page layer
  - advisory matching is intentionally narrow: exact `app_users.handle_norm` matches derived from the verified eBay username candidates only
  - operators may update only `reviewState`, `reviewNotes`, and one advisory candidate-match selection; unknown or destructive-looking fields are rejected by the route allowlist
  - the trusted operator identity source is the current Clerk user; review-route audit attribution comes from the verified internal admin session as canonical `clerk:<clerk_user_id>`, not from request headers
  - internal admin page access is revocable by removing the operator's Clerk user id or email from the allowlist; protected page requests re-check the allowlist before honoring the signed session cookie
  - every meaningful review mutation now appends an audit event in `public.ebay_deletion_manual_review_events`
  - `task_viewed` is intentionally not audited yet because it would be too noisy for the current phase
  - the human review process is documented in `docs/security/ebay-deletion-review-runbook.md`
  - there is still no destructive deletion, erasure, or user-mutation route in this workflow
  - these admin routes are locked to `ADMIN_ROUTES`, and `check:route-coverage` now fails if they drift out of the `admin` classification
- internal/admin route trust matrix:
  - the machine-enforced source of truth is `INTERNAL_ROUTE_TRUST_CONTRACTS` in `scripts/security-guardrails.config.mjs`
  - `internal_admin_session` routes:
    - `admin/ebay-deletion-tasks`, `admin/ebay-deletion-tasks/[id]`
    - intended caller: `/internal/admin/ebay-deletion-tasks`
    - auth: `requireInternalAdminApiAccess(req)` backed by the Clerk allowlisted internal-admin session
    - UI-backed: yes
    - `dbAdmin()`: indirect via `lib/ebay/deletion-review.ts`
  - `admin_secret` routes:
    - `admin/import/pokemontcg-canonical`, `admin/import/scrydex-canonical`, `admin/import/printings`, `admin/psa-seeds`
    - intended caller: manual admin/import/server-to-server tooling
    - auth: `requireAdmin(req)`
    - UI-backed: no
    - `dbAdmin()`: direct
  - `admin_import_token` route:
    - `admin/import/pokemontcg`
    - intended caller: import automation using `ADMIN_IMPORT_TOKEN`
    - auth: import-token bearer
    - UI-backed: no
    - `dbAdmin()`: indirect through `lib/admin/scrydex-canonical-import.ts`
  - `cron_secret` routes:
    - `cron/ingest-fx-rates`, `cron/check-fx-rates-health`, `cron/ingest-justtcg-raw`, `cron/ingest-pokemontcg-raw`, `cron/normalize-justtcg-raw`, `cron/normalize-poketrace-raw`, `cron/normalize-pokemontcg-raw`, `cron/match-justtcg-normalized`, `cron/match-pokemontcg-normalized`, `cron/write-provider-timeseries`, `cron/run-justtcg-pipeline`, `cron/run-justtcg-retry`, `cron/run-scrydex-pipeline`, `cron/backfill-scrydex-price-history`, `cron/run-scrydex-2024plus-daily/[chunk]`, `cron/run-scrydex-retry`, `cron/run-poketrace-pipeline`, `cron/run-pokemontcg-pipeline`, `cron/process-provider-pipeline-jobs`, `cron/process-ebay-deletion-receipts`, `cron/sync-canonical`, `cron/sync-tcg-prices`, `cron/refresh-card-metrics`, `cron/refresh-card-embeddings`, `cron/capture-pricing-transparency`, `cron/capture-matching-quality`, `cron/snapshot-price-history`, `cron/refresh-derived-signals`, `cron/refresh-set-summaries`
    - intended caller: cron/internal automation only
    - auth: `requireCron(req)` (admin also accepted by the shared cron guard)
    - UI-backed: no
    - `dbAdmin()`: direct or helper-owned service access only
- debug route trust matrix:
  - the machine-enforced source of truth is `DEBUG_ROUTE_TRUST_CONTRACTS` in `scripts/security-guardrails.config.mjs`
  - current `debug_cron_guard` routes:
    - `debug/asset-inspect`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg-inspect`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: helper-owned service access
      - should stay route: yes
    - `debug/justtcg-match-summary`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg-normalized-signals`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg-raw-signals`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg-unmatched-diagnostics`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg/backfill-first-edition-printings`
      - intended caller: internal repair and backfill tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg/backfill-set`
      - intended caller: internal repair and backfill tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: no direct call in the route; delegated helper
      - should stay route: yes
    - `debug/justtcg/backfill-tracked-mappings`
      - intended caller: internal repair and backfill tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg/precheck-repair-sets`
      - intended caller: internal repair precheck tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg/repair-pokeball-stamp`
      - intended caller: internal repair tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/justtcg/repair-set-finishes`
      - intended caller: internal repair tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/market-summary`
      - intended caller: internal diagnostic requests and cache verification
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/provider-price-readings`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/tracked-assets`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/tracked-assets/seed`
      - intended caller: internal seeding and repair tooling
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
    - `debug/tracked-refresh-diagnostics`
      - intended caller: internal diagnostic requests and operator troubleshooting
      - auth: `requireCron(req)`
      - UI-backed: no
      - `dbAdmin()`: direct
      - should stay route: yes
  - no current debug routes use trusted internal-admin session auth
  - no current debug routes are marked deprecated, but the trust contract supports explicit shutdown classification if one needs to stay in place temporarily while callers are removed
- route-to-route bridge policy:
  - keep routes for real network boundaries only: operator UI, external/manual admin tooling, cron invocation, or script targets
  - shared server logic belongs in `lib/`, not in one route importing or fetching another route just for reuse
  - `lib/admin/scrydex-canonical-import.ts` now holds the canonical import implementation used by `admin/import/scrydex-canonical`, `admin/import/pokemontcg-canonical`, `admin/import/pokemontcg`, and `cron/sync-canonical`
  - remaining justified bridge patterns in admin/cron/debug: none
- Public write route rules:
  - add every `public` or `ingest` write route to `PUBLIC_WRITE_ROUTE_CONTRACTS` in `scripts/security-guardrails.config.mjs`
  - use the shared `lib/public-write.mjs` helper so logs always include `surface`, `route`, `outcome`, and hashed request identifiers
  - prefer the standard outcome vocabulary: `inserted`, `accepted`, `duplicate_noop`, `validation_failed`, `suspected_abuse`, `throttled`, `error`
  - prefer route-level throttling and screening first; only expose a public callable function if a route cannot reasonably sit in front of the write
- Common fixes when a guardrail fails:
  - `npm run check:security:doctor`: install or expose a Supabase CLI, restore `supabase/.temp/project-ref`, or set `SUPABASE_DB_PASSWORD` in `.env.local`
  - `npm run check:route-coverage`: add the missing route key to the correct array in `lib/auth/route-registry.ts`
  - `npm run check:internal-route-trust`: add or fix the route entry in `INTERNAL_ROUTE_TRUST_CONTRACTS`, or move the route onto the correct guard for its caller type
  - `npm run check:debug-route-trust`: add or fix the route entry in `DEBUG_ROUTE_TRUST_CONTRACTS`, or move the route onto the correct guard for its caller type
  - `npm run check:public-writes`: classify the route in `PUBLIC_WRITE_ROUTE_CONTRACTS`, or tighten/reclassify it so it is no longer a public or ingest write route
  - `npm run check:script-trust`: add or fix the script entry in `OPERATIONAL_SCRIPT_TRUST_CONTRACTS`, or move the logic behind a shared module/internal route if the script should not carry that trust directly
  - `npm run check:dbadmin`: move the route/helper to `dbPublic()` or `createServerSupabaseUserClient()`, or add a narrowly justified internal allowlist entry
  - `npm run check:security:schema` or `npm run check:security:schema:local`: add the missing migration to enable RLS, tighten grants, revoke unintended `EXECUTE`, or update the explicit contract after review
  - `npm run verify:rls:linked`: treat failures as behavior regressions in row visibility or ownership stamping, not as documentation drift

## How To Add a New Table Safely

1. Decide the class first: `public read`, `user-owned`, `write-only public`, or `internal service-only`.
2. Pick the owner column convention up front:
   - identity row: `clerk_user_id text`
   - owned row: `owner_clerk_id text`
   - directional social row: explicit relationship IDs like `follower_id text`
3. Add the index in the same migration for every column used in `USING`, `WITH CHECK`, or common ownership filters.
4. Enable RLS in the same migration for every `user-owned` table before the route ships.
5. Write explicit policies per operation; never use blanket "`authenticated` can do everything".
6. Add explicit grants that match the table class:
   - public read: `GRANT SELECT`
   - user-owned: grant only the operations the route actually needs to `authenticated`
   - internal: no `anon` / `authenticated` grants
7. If the table inserts through a sequence, classify the sequence in `scripts/security-guardrails.config.mjs` and grant only the minimum needed privilege, typically `USAGE`.
8. Prefer public read through views when the base table contains extra columns or should keep a narrower contract.
9. Use `security_invoker` on views only when the view must obey underlying RLS; otherwise use a safe projection or aggregate view with explicit columns and filters.
10. Route rules:
   - public data route: `dbPublic()`
   - authenticated user route: `createServerSupabaseUserClient()`
   - admin / cron / ingest / debug: `dbAdmin()`
11. Add a verification case for anon, user A, and user B before calling the table ready.

## Rollout Order

1. Phase 1: Clerk-native auth bridge, `app_users`, `holdings`, `private_sales`, profile/push/community user tables, and user-route refactors.
2. Phase 2: public catalog/read-model contract cleanup, `SELECT`-only grants on public views, and write-only public tables such as `waitlist_signups`.
3. Phase 3: internal/provider/debug/admin tables and paywalled views; revoke broad public-schema grants across the remaining operational tables.
4. Phase 4: remove legacy ownership columns such as `holdings.user_id` and `private_sales.owner_id` only after backfill and production validation prove they are no longer needed.

import { createClient } from "@supabase/supabase-js";
import { submitWaitlistSignup } from "../lib/data/waitlist.mjs";
import { PHASE2_INTERNAL_OPERATIONAL_TABLES } from "./security-guardrails.config.mjs";
import { PHASE2_PROVIDER_AND_MAPPING_TABLES } from "./security-guardrails.config.mjs";
import { PHASE2_DIRECT_PUBLIC_READ_TABLES } from "./security-guardrails.config.mjs";
import { PHASE2_INTERNAL_BASE_VIEW_TABLES } from "./security-guardrails.config.mjs";
import { PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES } from "./security-guardrails.config.mjs";
import { PHASE3_PUBLIC_SELECT_ONLY_VIEWS } from "./security-guardrails.config.mjs";
import { PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS } from "./security-guardrails.config.mjs";
import { PHASE3_INTERNAL_NO_GRANT_VIEWS } from "./security-guardrails.config.mjs";
import { PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES } from "./security-guardrails.config.mjs";
import { runLinkedDbCommand } from "./lib/linked-db.mjs";

function sqlLiteral(value) {
  return value.replaceAll("'", "''");
}

function jwtClaims(role, sub = null) {
  return sqlLiteral(JSON.stringify(sub ? { role, sub } : { role }));
}

function mondayStartIso(date = new Date()) {
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset);
  return value.toISOString().slice(0, 10);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runQuery(sql, { expectFailure = false, label } = {}) {
  return runLinkedDbCommand(sql, {
    expectFailure,
    executionMode: "linked",
    label: label ?? "query",
  });
}

function assertRoleCannotReadInternalTable(tableName, role, sub = null) {
  runQuery(`
begin;
set local role ${role};
select set_config('request.jwt.claims', '${jwtClaims(role, sub)}', true);
select count(*)::int from public.${tableName};
rollback;
`, { expectFailure: true, label: `${role} ${tableName} select` });
}

function buildSelectPrivilegeProjection(role, tables) {
  return tables
    .map((tableName) => `has_table_privilege('${role}', 'public.${tableName}', 'SELECT') as ${tableName}`)
    .join(",\n  ");
}

function buildPrivilegeProjection(role, tables, privilege) {
  return tables
    .map((tableName) => `has_table_privilege('${role}', 'public.${tableName}', '${privilege}') as ${tableName}`)
    .join(",\n  ");
}

function buildReadableProjection(tables) {
  return tables
    .map((tableName) => `coalesce((select true from public.${tableName} limit 1), true) as ${tableName}`)
    .join(",\n  ");
}

function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY for waitlist verification.");
  }

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function createAdminClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for waitlist verification.");
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

const suffix = `${Date.now()}`;
const userA = `user_rls_${suffix}_a`;
const userB = `user_rls_${suffix}_b`;
const holdingMarker = `rls_holding_${suffix}`;
const privateSaleNote = `rls_private_sale_${suffix}`;
const voteSlug = `rls-vote-${suffix}`;
const weekStart = mondayStartIso();
const waitlistAnonEmail = `waitlist-anon-${suffix}@example.com`;
const waitlistUserEmail = `waitlist-user-${suffix}@example.com`;

const ownRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users default values;
insert into public.holdings (grade, qty, price_paid_usd, venue)
values ('RAW', 1, 1.25, '${sqlLiteral(holdingMarker)}');
insert into public.private_sales (cert, price, sold_at, notes)
values ('RLS-${suffix}', 15.5, now(), '${sqlLiteral(privateSaleNote)}');
select
  (select clerk_user_id from public.app_users where clerk_user_id = '${sqlLiteral(userA)}') as app_user_id,
  (select owner_clerk_id from public.holdings where venue = '${sqlLiteral(holdingMarker)}' order by created_at desc limit 1) as holding_owner,
  (select owner_clerk_id from public.private_sales where notes = '${sqlLiteral(privateSaleNote)}' order by created_at desc limit 1) as private_sale_owner;
rollback;
`, { label: "own data test" });

assert(ownRows.length === 1, "own data test returned no rows");
assert(ownRows[0].app_user_id === userA, "app_users did not stamp the Clerk owner correctly");
assert(ownRows[0].holding_owner === userA, "holdings did not stamp the Clerk owner correctly");
assert(ownRows[0].private_sale_owner === userA, "private_sales did not stamp the Clerk owner correctly");

const isolationRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users default values;
insert into public.holdings (grade, qty, price_paid_usd, venue)
values ('RAW', 1, 1.25, '${sqlLiteral(holdingMarker)}');
insert into public.private_sales (cert, price, sold_at, notes)
values ('RLS-${suffix}', 15.5, now(), '${sqlLiteral(privateSaleNote)}');
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
select
  (select count(*)::int from public.app_users where clerk_user_id = '${sqlLiteral(userA)}') as visible_app_users,
  (select count(*)::int from public.holdings where venue = '${sqlLiteral(holdingMarker)}') as visible_holdings,
  (select count(*)::int from public.private_sales where notes = '${sqlLiteral(privateSaleNote)}') as visible_private_sales;
rollback;
`, { label: "cross-user isolation test" });

assert(isolationRows.length === 1, "cross-user isolation test returned no rows");
assert(Number(isolationRows[0].visible_app_users) === 0, "user B can see user A app_users row");
assert(Number(isolationRows[0].visible_holdings) === 0, "user B can see user A holdings rows");
assert(Number(isolationRows[0].visible_private_sales) === 0, "user B can see user A private sales rows");

const followRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users default values;
insert into public.community_card_votes (canonical_slug, vote_side, week_start)
values ('${sqlLiteral(voteSlug)}', 'up', '${weekStart}');
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
insert into public.profile_follows (followee_id) values ('${sqlLiteral(userA)}');
select count(*)::int as visible_followee_votes
from public.community_card_votes
where canonical_slug = '${sqlLiteral(voteSlug)}'
  and week_start = '${weekStart}'
  and voter_id = '${sqlLiteral(userA)}';
rollback;
`, { label: "followee vote visibility test" });

assert(followRows.length === 1, "followee vote visibility test returned no rows");
assert(Number(followRows[0].visible_followee_votes) === 1, "followee vote visibility did not work");

runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
insert into public.holdings (owner_clerk_id, grade, qty, price_paid_usd, venue)
values ('${sqlLiteral(userA)}', 'RAW', 1, 1.25, 'rls_bad_holding_${suffix}');
rollback;
`, { expectFailure: true, label: "cross-owner holdings insert" });

runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
insert into public.private_sales (owner_clerk_id, cert, price, sold_at, notes)
values ('${sqlLiteral(userA)}', 'RLS-BAD-${suffix}', 12.5, now(), 'rls_bad_private_sale_${suffix}');
rollback;
`, { expectFailure: true, label: "cross-owner private sales insert" });

runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select count(*)::int from public.app_users;
rollback;
`, { expectFailure: true, label: "anon app_users select" });

runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select count(*)::int from public.holdings;
rollback;
`, { expectFailure: true, label: "anon holdings select" });

runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select count(*)::int from public.private_sales;
rollback;
`, { expectFailure: true, label: "anon private_sales select" });

const phase2AnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE2_INTERNAL_OPERATIONAL_TABLES)};
`, { label: "phase2 internal operational anon grant matrix" });

assert(phase2AnonPrivileges.length === 1, "phase2 anon grant matrix returned no rows");
for (const tableName of PHASE2_INTERNAL_OPERATIONAL_TABLES) {
  assert(phase2AnonPrivileges[0][tableName] === false, `anon still has SELECT on ${tableName}`);
}

const phase2AuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE2_INTERNAL_OPERATIONAL_TABLES)};
`, { label: "phase2 internal operational authenticated grant matrix" });

assert(phase2AuthenticatedPrivileges.length === 1, "phase2 authenticated grant matrix returned no rows");
for (const tableName of PHASE2_INTERNAL_OPERATIONAL_TABLES) {
  assert(phase2AuthenticatedPrivileges[0][tableName] === false, `authenticated still has SELECT on ${tableName}`);
}

assertRoleCannotReadInternalTable("pipeline_jobs", "authenticated", userA);
assertRoleCannotReadInternalTable("tracked_assets", "authenticated", userA);

const phase2ProviderAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE2_PROVIDER_AND_MAPPING_TABLES)};
`, { label: "phase2 provider anon grant matrix" });

assert(phase2ProviderAnonPrivileges.length === 1, "phase2 provider anon grant matrix returned no rows");
for (const tableName of PHASE2_PROVIDER_AND_MAPPING_TABLES) {
  assert(phase2ProviderAnonPrivileges[0][tableName] === false, `anon still has SELECT on ${tableName}`);
}

const phase2ProviderAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE2_PROVIDER_AND_MAPPING_TABLES)};
`, { label: "phase2 provider authenticated grant matrix" });

assert(phase2ProviderAuthenticatedPrivileges.length === 1, "phase2 provider authenticated grant matrix returned no rows");
for (const tableName of PHASE2_PROVIDER_AND_MAPPING_TABLES) {
  assert(phase2ProviderAuthenticatedPrivileges[0][tableName] === false, `authenticated still has SELECT on ${tableName}`);
}

assertRoleCannotReadInternalTable("provider_raw_payloads", "authenticated", userA);
assertRoleCannotReadInternalTable("provider_set_map", "authenticated", userA);

const phase2ReferenceAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES)};
`, { label: "phase2 psa/reference anon grant matrix" });

assert(phase2ReferenceAnonPrivileges.length === 1, "phase2 psa/reference anon grant matrix returned no rows");
for (const tableName of PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES) {
  assert(phase2ReferenceAnonPrivileges[0][tableName] === false, `anon still has SELECT on ${tableName}`);
}

const phase2ReferenceAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES)};
`, { label: "phase2 psa/reference authenticated grant matrix" });

assert(phase2ReferenceAuthenticatedPrivileges.length === 1, "phase2 psa/reference authenticated grant matrix returned no rows");
for (const tableName of PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES) {
  assert(phase2ReferenceAuthenticatedPrivileges[0][tableName] === false, `authenticated still has SELECT on ${tableName}`);
}

assertRoleCannotReadInternalTable("psa_cert_cache", "authenticated", userA);
assertRoleCannotReadInternalTable("realized_sales_backtest_snapshots", "authenticated", userA);

const phase2DirectPublicAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE2_DIRECT_PUBLIC_READ_TABLES)};
`, { label: "phase2 direct public-read anon grant matrix" });

assert(phase2DirectPublicAnonPrivileges.length === 1, "phase2 direct public-read anon grant matrix returned no rows");
for (const tableName of PHASE2_DIRECT_PUBLIC_READ_TABLES) {
  assert(phase2DirectPublicAnonPrivileges[0][tableName] === true, `anon lost SELECT on ${tableName}`);
}

const phase2DirectPublicAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE2_DIRECT_PUBLIC_READ_TABLES)};
`, { label: "phase2 direct public-read authenticated grant matrix" });

assert(phase2DirectPublicAuthenticatedPrivileges.length === 1, "phase2 direct public-read authenticated grant matrix returned no rows");
for (const tableName of PHASE2_DIRECT_PUBLIC_READ_TABLES) {
  assert(phase2DirectPublicAuthenticatedPrivileges[0][tableName] === true, `authenticated lost SELECT on ${tableName}`);
}

const phase2InternalBaseAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE2_INTERNAL_BASE_VIEW_TABLES)};
`, { label: "phase2 internal base-view anon grant matrix" });

assert(phase2InternalBaseAnonPrivileges.length === 1, "phase2 internal base-view anon grant matrix returned no rows");
for (const tableName of PHASE2_INTERNAL_BASE_VIEW_TABLES) {
  assert(phase2InternalBaseAnonPrivileges[0][tableName] === false, `anon still has SELECT on ${tableName}`);
}

const phase2InternalBaseAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE2_INTERNAL_BASE_VIEW_TABLES)};
`, { label: "phase2 internal base-view authenticated grant matrix" });

assert(phase2InternalBaseAuthenticatedPrivileges.length === 1, "phase2 internal base-view authenticated grant matrix returned no rows");
for (const tableName of PHASE2_INTERNAL_BASE_VIEW_TABLES) {
  assert(phase2InternalBaseAuthenticatedPrivileges[0][tableName] === false, `authenticated still has SELECT on ${tableName}`);
}

assertRoleCannotReadInternalTable("card_metrics", "anon");
assertRoleCannotReadInternalTable("variant_metrics", "authenticated", userA);
assertRoleCannotReadInternalTable("price_history", "authenticated", userA);
assertRoleCannotReadInternalTable("set_summary_snapshots", "authenticated", userA);

const phase3PublicReadAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES)};
`, { label: "phase3 existing public/internal-write anon grant matrix" });

assert(phase3PublicReadAnonPrivileges.length === 1, "phase3 existing public/internal-write anon grant matrix returned no rows");
for (const tableName of PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES) {
  assert(phase3PublicReadAnonPrivileges[0][tableName] === true, `anon lost SELECT on ${tableName}`);
}

const phase3PublicReadAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES)};
`, { label: "phase3 existing public/internal-write authenticated grant matrix" });

assert(phase3PublicReadAuthenticatedPrivileges.length === 1, "phase3 existing public/internal-write authenticated grant matrix returned no rows");
for (const tableName of PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES) {
  assert(phase3PublicReadAuthenticatedPrivileges[0][tableName] === true, `authenticated lost SELECT on ${tableName}`);
}

const phase3PublicViewAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE3_PUBLIC_SELECT_ONLY_VIEWS)};
`, { label: "phase3 public view anon grant matrix" });

assert(phase3PublicViewAnonPrivileges.length === 1, "phase3 public view anon grant matrix returned no rows");
for (const viewName of PHASE3_PUBLIC_SELECT_ONLY_VIEWS) {
  assert(phase3PublicViewAnonPrivileges[0][viewName] === true, `anon lost SELECT on ${viewName}`);
}

const phase3PublicViewAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE3_PUBLIC_SELECT_ONLY_VIEWS)};
`, { label: "phase3 public view authenticated grant matrix" });

assert(phase3PublicViewAuthenticatedPrivileges.length === 1, "phase3 public view authenticated grant matrix returned no rows");
for (const viewName of PHASE3_PUBLIC_SELECT_ONLY_VIEWS) {
  assert(phase3PublicViewAuthenticatedPrivileges[0][viewName] === true, `authenticated lost SELECT on ${viewName}`);
}

const phase3AuthenticatedViewAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS)};
`, { label: "phase3 authenticated-only view anon grant matrix" });

assert(phase3AuthenticatedViewAnonPrivileges.length === 1, "phase3 authenticated-only view anon grant matrix returned no rows");
for (const viewName of PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS) {
  assert(phase3AuthenticatedViewAnonPrivileges[0][viewName] === false, `anon still has SELECT on ${viewName}`);
}

const phase3AuthenticatedViewAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS)};
`, { label: "phase3 authenticated-only view authenticated grant matrix" });

assert(phase3AuthenticatedViewAuthenticatedPrivileges.length === 1, "phase3 authenticated-only view authenticated grant matrix returned no rows");
for (const viewName of PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS) {
  assert(phase3AuthenticatedViewAuthenticatedPrivileges[0][viewName] === true, `authenticated lost SELECT on ${viewName}`);
}

const phase3InternalViewAnonPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("anon", PHASE3_INTERNAL_NO_GRANT_VIEWS)};
`, { label: "phase3 internal/paywalled view anon grant matrix" });

assert(phase3InternalViewAnonPrivileges.length === 1, "phase3 internal/paywalled view anon grant matrix returned no rows");
for (const viewName of PHASE3_INTERNAL_NO_GRANT_VIEWS) {
  assert(phase3InternalViewAnonPrivileges[0][viewName] === false, `anon still has SELECT on ${viewName}`);
}

const phase3InternalViewAuthenticatedPrivileges = runQuery(`
select
  ${buildSelectPrivilegeProjection("authenticated", PHASE3_INTERNAL_NO_GRANT_VIEWS)};
`, { label: "phase3 internal/paywalled view authenticated grant matrix" });

assert(phase3InternalViewAuthenticatedPrivileges.length === 1, "phase3 internal/paywalled view authenticated grant matrix returned no rows");
for (const viewName of PHASE3_INTERNAL_NO_GRANT_VIEWS) {
  assert(phase3InternalViewAuthenticatedPrivileges[0][viewName] === false, `authenticated still has SELECT on ${viewName}`);
}

assertRoleCannotReadInternalTable("pro_variant_metrics", "anon");
assertRoleCannotReadInternalTable("pro_variant_metrics", "authenticated", userA);
assertRoleCannotReadInternalTable("market_snapshot_rollups", "anon");

const publicRows = runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select
  ${buildReadableProjection(PHASE2_DIRECT_PUBLIC_READ_TABLES)},
  ${buildReadableProjection(PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES)},
  coalesce((select true from public.public_card_metrics limit 1), true) as has_public_card_metrics,
  coalesce((select true from public.public_price_history limit 1), true) as has_public_price_history,
  coalesce((select true from public.public_market_latest limit 1), true) as has_public_market_latest,
  coalesce((select true from public.public_psa_snapshots limit 1), true) as has_public_psa_snapshots,
  coalesce((select true from public.public_set_summaries limit 1), true) as has_public_set_summaries,
  coalesce((select true from public.public_set_finish_summary limit 1), true) as has_public_set_finish_summary,
  coalesce((select true from public.public_variant_metrics limit 1), true) as has_public_variant_metrics,
  coalesce((select true from public.public_variant_movers limit 1), true) as has_public_variant_movers,
  coalesce((select true from public.public_variant_movers_priced limit 1), true) as has_public_variant_movers_priced,
  exists(select 1 from public.pricing_transparency_snapshots) as has_public_transparency_snapshots;
rollback;
`, { label: "public catalog read test" });

assert(publicRows.length === 1, "public catalog read test returned no rows");
assert(publicRows[0].canonical_cards === true, "anon read failed for canonical_cards");
assert(publicRows[0].card_aliases === true, "anon read failed for card_aliases");
assert(publicRows[0].card_printings === true, "anon read failed for card_printings");
assert(publicRows[0].card_profiles === true, "anon read failed for card_profiles");
assert(publicRows[0].deck_cards === true, "anon read failed for deck_cards");
assert(publicRows[0].fx_rates === true, "anon read failed for fx_rates");
assert(publicRows[0].printing_aliases === true, "anon read failed for printing_aliases");
assert(publicRows[0].canonical_raw_provider_parity === true, "anon read failed for canonical_raw_provider_parity");
assert(publicRows[0].market_snapshots === true, "anon read failed for market_snapshots");
assert(publicRows[0].pricing_transparency_snapshots === true, "anon read failed for pricing_transparency_snapshots");
assert(publicRows[0].has_public_card_metrics === true, "anon read failed for public_card_metrics");
assert(publicRows[0].has_public_price_history === true, "anon read failed for public_price_history");
assert(publicRows[0].has_public_market_latest === true, "anon read failed for public_market_latest");
assert(publicRows[0].has_public_psa_snapshots === true, "anon read failed for public_psa_snapshots");
assert(publicRows[0].has_public_set_summaries === true, "anon read failed for public_set_summaries");
assert(publicRows[0].has_public_set_finish_summary === true, "anon read failed for public_set_finish_summary");
assert(publicRows[0].has_public_variant_metrics === true, "anon read failed for public_variant_metrics");
assert(publicRows[0].has_public_variant_movers === true, "anon read failed for public_variant_movers");
assert(publicRows[0].has_public_variant_movers_priced === true, "anon read failed for public_variant_movers_priced");
assert(publicRows[0].has_public_transparency_snapshots === true, "anon read failed for pricing_transparency_snapshots");

runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select count(*)::int from public.pipeline_jobs;
rollback;
`, { expectFailure: true, label: "anon pipeline_jobs select" });

const contractRows = runQuery(`
select
  has_table_privilege('anon', 'public.canonical_cards', 'INSERT') as anon_canonical_insert,
  has_table_privilege('anon', 'public.canonical_raw_provider_parity', 'INSERT') as anon_parity_insert,
  has_table_privilege('authenticated', 'public.canonical_raw_provider_parity', 'UPDATE') as auth_parity_update,
  has_table_privilege('anon', 'public.market_snapshots', 'INSERT') as anon_market_snapshots_insert,
  has_table_privilege('authenticated', 'public.market_snapshots', 'UPDATE') as auth_market_snapshots_update,
  has_table_privilege('anon', 'public.pricing_transparency_snapshots', 'INSERT') as anon_pricing_transparency_insert,
  has_table_privilege('authenticated', 'public.pricing_transparency_snapshots', 'UPDATE') as auth_pricing_transparency_update,
  has_table_privilege('anon', 'public.public_card_metrics', 'INSERT') as anon_public_card_metrics_insert,
  has_table_privilege('anon', 'public.public_user_profiles', 'INSERT') as anon_public_user_profiles_insert,
  has_table_privilege('anon', 'public.public_set_summaries', 'INSERT') as anon_public_set_summaries_insert,
  has_table_privilege('authenticated', 'public.public_card_metrics', 'UPDATE') as auth_public_card_metrics_update,
  has_table_privilege('authenticated', 'public.public_user_profiles', 'UPDATE') as auth_public_user_profiles_update,
  has_table_privilege('authenticated', 'public.public_set_summaries', 'UPDATE') as auth_public_set_summaries_update,
  has_table_privilege('anon', 'public.community_user_vote_weeks', 'SELECT') as anon_community_user_vote_weeks_select,
  has_table_privilege('authenticated', 'public.community_user_vote_weeks', 'SELECT') as auth_community_user_vote_weeks_select,
  has_table_privilege('anon', 'public.pro_variant_metrics', 'SELECT') as anon_pro_variant_metrics_select,
  has_table_privilege('authenticated', 'public.pro_variant_metrics', 'SELECT') as auth_pro_variant_metrics_select,
  has_table_privilege('anon', 'public.market_snapshot_rollups', 'SELECT') as anon_market_snapshot_rollups_select,
  has_table_privilege('authenticated', 'public.market_snapshot_rollups', 'SELECT') as auth_market_snapshot_rollups_select,
  has_table_privilege('anon', 'public.waitlist_signups', 'INSERT') as anon_waitlist_insert,
  has_table_privilege('authenticated', 'public.waitlist_signups', 'INSERT') as auth_waitlist_insert,
  has_table_privilege('anon', 'public.waitlist_signups', 'SELECT') as anon_waitlist_select,
  has_table_privilege('anon', 'public.waitlist_signups', 'UPDATE') as anon_waitlist_update,
  has_table_privilege('authenticated', 'public.waitlist_signups', 'UPDATE') as auth_waitlist_update,
  has_table_privilege('anon', 'public.card_page_views', 'SELECT') as anon_card_page_views_select,
  has_table_privilege('authenticated', 'public.card_page_views', 'SELECT') as auth_card_page_views_select,
  has_table_privilege('anon', 'public.provider_raw_payloads', 'SELECT') as anon_provider_raw_select,
  has_function_privilege('anon', 'public.record_card_page_view(text)', 'EXECUTE') as anon_can_exec_record_card_page_view,
  has_function_privilege('anon', 'public.refresh_card_metrics()', 'EXECUTE') as anon_can_exec_refresh_card_metrics,
  has_function_privilege('anon', 'public.requesting_clerk_user_id()', 'EXECUTE') as anon_can_exec_requesting_clerk_user_id,
  has_function_privilege('authenticated', 'public.resolve_profile_handle(text)', 'EXECUTE') as auth_can_exec_resolve_profile_handle,
  has_function_privilege('anon', 'public.resolve_profile_handle(text)', 'EXECUTE') as anon_can_exec_resolve_profile_handle;
`, { label: "grant contract test" });

assert(contractRows.length === 1, "grant contract test returned no rows");
assert(contractRows[0].anon_canonical_insert === false, "anon still has INSERT on canonical_cards");
assert(contractRows[0].anon_parity_insert === false, "anon still has INSERT on canonical_raw_provider_parity");
assert(contractRows[0].auth_parity_update === false, "authenticated still has UPDATE on canonical_raw_provider_parity");
assert(contractRows[0].anon_market_snapshots_insert === false, "anon still has INSERT on market_snapshots");
assert(contractRows[0].auth_market_snapshots_update === false, "authenticated still has UPDATE on market_snapshots");
assert(contractRows[0].anon_pricing_transparency_insert === false, "anon still has INSERT on pricing_transparency_snapshots");
assert(contractRows[0].auth_pricing_transparency_update === false, "authenticated still has UPDATE on pricing_transparency_snapshots");
assert(contractRows[0].anon_public_card_metrics_insert === false, "anon still has INSERT on public_card_metrics");
assert(contractRows[0].anon_public_user_profiles_insert === false, "anon still has INSERT on public_user_profiles");
assert(contractRows[0].anon_public_set_summaries_insert === false, "anon still has INSERT on public_set_summaries");
assert(contractRows[0].auth_public_card_metrics_update === false, "authenticated still has UPDATE on public_card_metrics");
assert(contractRows[0].auth_public_user_profiles_update === false, "authenticated still has UPDATE on public_user_profiles");
assert(contractRows[0].auth_public_set_summaries_update === false, "authenticated still has UPDATE on public_set_summaries");
assert(contractRows[0].anon_community_user_vote_weeks_select === false, "anon still has SELECT on community_user_vote_weeks");
assert(contractRows[0].auth_community_user_vote_weeks_select === true, "authenticated lost SELECT on community_user_vote_weeks");
assert(contractRows[0].anon_pro_variant_metrics_select === false, "anon still has SELECT on pro_variant_metrics");
assert(contractRows[0].auth_pro_variant_metrics_select === false, "authenticated still has SELECT on pro_variant_metrics");
assert(contractRows[0].anon_market_snapshot_rollups_select === false, "anon still has SELECT on market_snapshot_rollups");
assert(contractRows[0].auth_market_snapshot_rollups_select === false, "authenticated still has SELECT on market_snapshot_rollups");
assert(contractRows[0].anon_waitlist_insert === true, "anon lost required INSERT on waitlist_signups");
assert(contractRows[0].auth_waitlist_insert === true, "authenticated lost required INSERT on waitlist_signups");
assert(contractRows[0].anon_waitlist_select === false, "anon still has SELECT on waitlist_signups");
assert(contractRows[0].anon_waitlist_update === false, "anon still has UPDATE on waitlist_signups");
assert(contractRows[0].auth_waitlist_update === false, "authenticated still has UPDATE on waitlist_signups");
assert(contractRows[0].anon_card_page_views_select === false, "anon still has SELECT on card_page_views");
assert(contractRows[0].auth_card_page_views_select === false, "authenticated still has SELECT on card_page_views");
assert(contractRows[0].anon_provider_raw_select === false, "anon still has SELECT on provider_raw_payloads");
assert(contractRows[0].anon_can_exec_record_card_page_view === false, "anon still has EXECUTE on record_card_page_view");
assert(contractRows[0].anon_can_exec_refresh_card_metrics === false, "anon still has EXECUTE on refresh_card_metrics");
assert(contractRows[0].anon_can_exec_requesting_clerk_user_id === false, "anon still has EXECUTE on requesting_clerk_user_id");
assert(contractRows[0].auth_can_exec_resolve_profile_handle === true, "authenticated lost EXECUTE on resolve_profile_handle");
assert(contractRows[0].anon_can_exec_resolve_profile_handle === false, "anon still has EXECUTE on resolve_profile_handle");

const publicProfileRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users (clerk_user_id, handle, handle_norm, profile_visibility)
values ('${sqlLiteral(userA)}', 'pub${suffix}a', 'pub${suffix}a', 'PUBLIC');
insert into public.profile_posts (body)
values ('public_profile_post_${suffix}');
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users (clerk_user_id, handle, handle_norm, profile_visibility)
values ('${sqlLiteral(userB)}', 'pri${suffix}b', 'pri${suffix}b', 'PRIVATE');
insert into public.profile_posts (body)
values ('private_profile_post_${suffix}');
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select
  (select count(*)::int from public.public_user_profiles where handle in ('pub${suffix}a', 'pri${suffix}b')) as visible_profiles,
  (select count(*)::int from public.public_profile_posts where handle in ('pub${suffix}a', 'pri${suffix}b')) as visible_posts;
rollback;
`, { label: "public profile view test" });

assert(publicProfileRows.length === 1, "public profile view test returned no rows");
assert(Number(publicProfileRows[0].visible_profiles) === 1, "public_user_profiles leaked a private profile");
assert(Number(publicProfileRows[0].visible_posts) === 1, "public_profile_posts leaked a private profile post");

const viewBeforeRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users default values;
insert into public.community_card_votes (canonical_slug, vote_side, week_start)
values ('${sqlLiteral(voteSlug)}', 'up', '${weekStart}');
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
select
  (select count(*)::int from public.community_vote_feed_events where canonical_slug = '${sqlLiteral(voteSlug)}' and voter_id = '${sqlLiteral(userA)}') as feed_before,
  (select count(*)::int from public.community_user_vote_weeks where voter_id = '${sqlLiteral(userA)}' and week_start = '${weekStart}') as weeks_before;
rollback;
`, { label: "security invoker view before-follow test" });

assert(viewBeforeRows.length === 1, "security invoker view before-follow test returned no rows");
assert(Number(viewBeforeRows[0].feed_before) === 0, "community_vote_feed_events leaked before follow");
assert(Number(viewBeforeRows[0].weeks_before) === 0, "community_user_vote_weeks leaked before follow");

const viewAfterRows = runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.app_users default values;
insert into public.community_card_votes (canonical_slug, vote_side, week_start)
values ('${sqlLiteral(voteSlug)}', 'up', '${weekStart}');
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userB)}', true);
insert into public.app_users default values;
insert into public.profile_follows (followee_id)
values ('${sqlLiteral(userA)}');
select
  (select count(*)::int from public.community_vote_feed_events where canonical_slug = '${sqlLiteral(voteSlug)}' and voter_id = '${sqlLiteral(userA)}') as feed_after,
  (select count(*)::int from public.community_user_vote_weeks where voter_id = '${sqlLiteral(userA)}' and week_start = '${weekStart}') as weeks_after;
rollback;
`, { label: "security invoker view after-follow test" });

assert(viewAfterRows.length === 1, "security invoker view after-follow test returned no rows");
assert(Number(viewAfterRows[0].feed_after) === 1, "community_vote_feed_events did not respect follow-based visibility");
assert(Number(viewAfterRows[0].weeks_after) === 1, "community_user_vote_weeks did not respect follow-based visibility");

const publicClient = createPublicClient();
const adminClient = createAdminClient();

try {
  const anonSignup = await submitWaitlistSignup({
    supabase: publicClient,
    email: waitlistAnonEmail,
    tier: "Ace",
  });
  assert(anonSignup.inserted === true, "anon waitlist signup failed");

  const anonDuplicate = await submitWaitlistSignup({
    supabase: publicClient,
    email: waitlistAnonEmail,
    tier: "Ace",
  });
  assert(anonDuplicate.inserted === false, "duplicate anon waitlist signup was not treated as a no-op");

  runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.waitlist_signups (
  email,
  email_normalized,
  desired_tier,
  source,
  clerk_user_id
)
values (
  '${sqlLiteral(waitlistUserEmail)}',
  '${sqlLiteral(waitlistUserEmail)}',
  'Elite',
  'pricing_modal',
  '${sqlLiteral(userA)}'
);
commit;
`, { label: "authenticated waitlist signup test" });

  runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
insert into public.waitlist_signups (
  email,
  email_normalized,
  desired_tier,
  source,
  clerk_user_id
)
values (
  'waitlist-bad-anon-${suffix}@example.com',
  'waitlist-bad-anon-${suffix}@example.com',
  'Elite',
  'pricing_modal',
  '${sqlLiteral(userA)}'
);
rollback;
`, { expectFailure: true, label: "anon spoofed waitlist clerk_user_id insert" });

  runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
insert into public.waitlist_signups (
  email,
  email_normalized,
  desired_tier,
  source,
  clerk_user_id
)
values (
  'waitlist-bad-auth-${suffix}@example.com',
  'waitlist-bad-auth-${suffix}@example.com',
  'Elite',
  'pricing_modal',
  '${sqlLiteral(userB)}'
);
rollback;
`, { expectFailure: true, label: "authenticated mismatched waitlist clerk_user_id insert" });

  const { data: insertedRows, error: insertedRowsError } = await adminClient
    .from("waitlist_signups")
    .select("email_normalized, desired_tier, clerk_user_id, source")
    .in("email_normalized", [waitlistAnonEmail, waitlistUserEmail])
    .order("email_normalized", { ascending: true });
  if (insertedRowsError) {
    throw new Error(`waitlist verification read failed: ${insertedRowsError.message}`);
  }

  assert((insertedRows ?? []).length === 2, "waitlist verification did not persist exactly two rows");

  const anonRow = insertedRows?.find((row) => row.email_normalized === waitlistAnonEmail) ?? null;
  assert(anonRow?.desired_tier === "Ace", "anon waitlist row stored the wrong tier");
  assert(anonRow?.clerk_user_id === null, "anon waitlist row stored an unexpected Clerk user id");

  const authRow = insertedRows?.find((row) => row.email_normalized === waitlistUserEmail) ?? null;
  assert(authRow?.desired_tier === "Elite", "authenticated waitlist row stored the wrong tier");
  assert(authRow?.clerk_user_id === userA, "authenticated waitlist row lost the Clerk user id");
  assert(authRow?.source === "pricing_modal", "waitlist row stored the wrong source");

  const { data: blockedWaitlistRows, error: blockedWaitlistError } = await publicClient
    .from("waitlist_signups")
    .select("id")
    .limit(1);
  assert(blockedWaitlistError, "anon waitlist select unexpectedly succeeded");
  assert(blockedWaitlistRows === null, "anon waitlist select returned rows");

  runQuery(`
begin;
set local role anon;
select set_config('request.jwt.claims', '${jwtClaims("anon")}', true);
select count(*)::int from public.card_page_views;
rollback;
`, { expectFailure: true, label: "anon card_page_views select" });

  runQuery(`
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${jwtClaims("authenticated", userA)}', true);
select count(*)::int from public.card_page_views;
rollback;
`, { expectFailure: true, label: "authenticated card_page_views select" });
} finally {
  const { error: cleanupError } = await adminClient
    .from("waitlist_signups")
    .delete()
    .in("email_normalized", [waitlistAnonEmail, waitlistUserEmail]);
  if (cleanupError) {
    throw new Error(`waitlist verification cleanup failed: ${cleanupError.message}`);
  }
}

const adminRows = runQuery(`
select
  to_regclass('public.provider_raw_payloads') is not null as has_provider_raw_payloads,
  (select count(*) >= 0 from public.provider_raw_payloads) as admin_can_read_provider_raw_payloads;
`, { label: "admin access test" });

assert(adminRows.length === 1, "admin access test returned no rows");
assert(adminRows[0].has_provider_raw_payloads === true, "provider_raw_payloads table is missing");
assert(adminRows[0].admin_can_read_provider_raw_payloads === true, "admin access no longer works for provider_raw_payloads");

console.log("Phase 1 RLS verification passed.");
process.exit(0);

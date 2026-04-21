// Central contract for database and route guardrails.
// Keep this file explicit: every exposed public-schema object should be
// classified here so new surface area fails fast in CI.

export const DBADMIN_ALLOWED_PREFIXES = [
  "app/api/admin/",
  "app/api/cron/",
  "app/api/debug/",
  "app/api/ingest/",
  "app/api/market/observe/",
  "lib/admin/",
  "app/api/psa/cert/route.ts",
  "lib/backfill/",
  "lib/personalization/server/",
  "scripts/",
];

export const DBADMIN_ALLOWED_FILES = [
  "app/api/cards/[slug]/view/route.ts",
  "app/api/device/register/route.ts",
  "app/api/device/test-push/route.ts",
  "app/api/ebay/deletion-notification/route.ts",
  "app/api/holdings/route.ts",
  "app/api/personalization/events/route.ts",
  "app/api/personalization/explanation/route.ts",
  "app/api/personalization/profile/route.ts",
  "app/api/portfolio/overview/route.ts",
  "app/api/portfolio/activity/route.ts",
  "app/api/pro/signals/route.ts",
  "app/api/scan/identify/route.ts",
  "lib/data/app-user.ts",
  "lib/db/admin.ts",
];

export const DBADMIN_ALLOWED_ROUTE_KEYS = [
  "cards/[slug]/view",
  "device/register",
  "device/test-push",
  "holdings",
  "personalization/events",
  "personalization/explanation",
  "personalization/profile",
  "portfolio/overview",
  "portfolio/activity",
  "pro/signals",
  "scan/identify",
];

export const INTERNAL_ADMIN_PAGE_ROOTS = [
  "app/internal/admin",
];

export const INTERNAL_ADMIN_ALLOWED_PAGE_FETCH_PREFIXES = [
  "/api/admin/ebay-deletion-tasks",
];

function privilegedEntrypoint({
  type,
  intendedCaller,
  trustModel,
  requiredTrustInputs,
  expectedSignals,
  status = "active",
  notes = null,
}) {
  return {
    type,
    intendedCaller,
    trustModel,
    requiredTrustInputs,
    expectedSignals,
    status,
    notes,
  };
}

function packageScriptContract({
  target,
  intendedCaller,
  trustModel,
  requiredTrustInputs,
  expectedCommandFragments,
  status = "active",
  notes = null,
}) {
  return {
    target,
    intendedCaller,
    trustModel,
    requiredTrustInputs,
    expectedCommandFragments,
    status,
    notes,
  };
}

export const INTERNAL_ADMIN_UI_ENTRYPOINT_CONTRACTS = {
  "app/internal/admin/page.tsx": privilegedEntrypoint({
    type: "internal_admin_ui_redirect",
    intendedCaller: "allowlisted Clerk operator opening the internal admin root",
    trustModel: "internal_admin_session",
    requiredTrustInputs: ["internal_admin_cookie", "trusted_internal_admin_redirect"],
    expectedSignals: ["internal_admin_redirect"],
  }),
  "app/internal/admin/sign-in/page.tsx": privilegedEntrypoint({
    type: "internal_admin_sign_in_page",
    intendedCaller: "allowlisted Clerk operator establishing a short-lived internal admin session",
    trustModel: "clerk_allowlist_sign_in",
    requiredTrustInputs: ["INTERNAL_ADMIN_CLERK_USER_IDS or INTERNAL_ADMIN_EMAILS", "INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET"],
    expectedSignals: ["internal_admin_signin_ui", "clerk_user_resolution", "internal_admin_session_reader"],
  }),
  "app/internal/admin/actions.ts": privilegedEntrypoint({
    type: "internal_admin_session_actions",
    intendedCaller: "server actions handling internal admin sign-in/sign-out",
    trustModel: "clerk_allowlist_session_issue_clear",
    requiredTrustInputs: ["INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET", "internal_admin_cookie"],
    expectedSignals: ["internal_admin_session_issue_clear"],
  }),
  "app/internal/admin/(protected)/layout.tsx": privilegedEntrypoint({
    type: "internal_admin_protected_layout",
    intendedCaller: "allowlisted Clerk operator browsing the protected admin shell",
    trustModel: "internal_admin_session",
    requiredTrustInputs: ["internal_admin_cookie", "trusted_operator_display"],
    expectedSignals: ["require_internal_admin_session", "internal_admin_signout_action"],
  }),
  "app/internal/admin/(protected)/ebay-deletion-tasks/page.tsx": privilegedEntrypoint({
    type: "internal_admin_review_page",
    intendedCaller: "allowlisted Clerk operator reviewing eBay deletion tasks",
    trustModel: "internal_admin_session",
    requiredTrustInputs: ["internal_admin_cookie", "server_only_admin_review_api"],
    expectedSignals: ["require_internal_admin_session", "internal_admin_review_api"],
  }),
  "app/internal/admin/(protected)/ebay-deletion-tasks/actions.ts": privilegedEntrypoint({
    type: "internal_admin_review_actions",
    intendedCaller: "server actions mutating eBay manual-review fields",
    trustModel: "internal_admin_session",
    requiredTrustInputs: ["internal_admin_cookie", "audited_admin_review_patch"],
    expectedSignals: ["require_internal_admin_session", "internal_admin_review_patch"],
  }),
};

export const AUTH_GLUE_ENTRYPOINT_CONTRACTS = {
  "proxy.ts": privilegedEntrypoint({
    type: "middleware_auth_gate",
    intendedCaller: "Next.js runtime handling route classification and debug gating",
    trustModel: "clerk_middleware_route_classifier",
    requiredTrustInputs: ["ALLOW_DEBUG_IN_PROD", "lib/auth/route-registry.ts"],
    expectedSignals: ["clerk_middleware", "debug_prod_gate", "route_registry_import"],
  }),
  "lib/auth/clerk-enabled.ts": privilegedEntrypoint({
    type: "clerk_runtime_gate",
    intendedCaller: "server entrypoints that require Clerk in runtime environments",
    trustModel: "runtime_clerk_configuration_gate",
    requiredTrustInputs: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_RUNTIME_REQUIRED"],
    expectedSignals: ["clerk_runtime_flag"],
  }),
  "lib/auth/context.ts": privilegedEntrypoint({
    type: "request_auth_resolver",
    intendedCaller: "all guarded app/api routes resolving public/user/admin/cron auth",
    trustModel: "secret_or_clerk_request_auth",
    requiredTrustInputs: ["CRON_SECRET", "ADMIN_SECRET", "ADMIN_IMPORT_TOKEN"],
    expectedSignals: ["auth_secret_resolution", "safe_equal", "clerk_user_resolution"],
  }),
  "lib/auth/require.ts": privilegedEntrypoint({
    type: "request_auth_guard",
    intendedCaller: "route handlers enforcing resolved request auth kinds",
    trustModel: "resolved_request_auth_enforcement",
    requiredTrustInputs: ["resolveAuthContext"],
    expectedSignals: ["auth_guards"],
  }),
  "lib/auth/internal-admin-session-core.ts": privilegedEntrypoint({
    type: "internal_admin_session_core",
    intendedCaller: "internal admin page and API session creation/verification logic",
    trustModel: "signed_cookie_plus_allowlist",
    requiredTrustInputs: ["INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET", "INTERNAL_ADMIN_CLERK_USER_IDS or INTERNAL_ADMIN_EMAILS"],
    expectedSignals: ["internal_admin_session_signing", "internal_admin_allowlist"],
  }),
  "lib/auth/internal-admin-session.ts": privilegedEntrypoint({
    type: "internal_admin_session_runtime",
    intendedCaller: "internal admin pages and API routes re-validating trusted operator sessions",
    trustModel: "clerk_revalidation_plus_cookie_verification",
    requiredTrustInputs: ["Clerk runtime", "INTERNAL_ADMIN_SESSION_SECRET or ADMIN_SECRET"],
    expectedSignals: ["clerk_user_resolution", "internal_admin_session_signing", "internal_admin_allowlist"],
  }),
  "lib/auth/route-registry.ts": privilegedEntrypoint({
    type: "route_classification_registry",
    intendedCaller: "middleware and build-time route trust checks",
    trustModel: "explicit_api_route_classification",
    requiredTrustInputs: ["explicit_route_lists"],
    expectedSignals: ["route_registry"],
  }),
};

export const PRIVILEGED_PACKAGE_SCRIPT_CONTRACTS = {
  "check:security:doctor": packageScriptContract({
    target: "scripts/check-linked-db-prereqs.mjs",
    intendedCaller: "local developer or CI operator bootstrapping linked-schema checks",
    trustModel: "linked_db_bootstrap_wrapper",
    requiredTrustInputs: ["SUPABASE_CLI_PATH or supabase on PATH", "SUPABASE_DB_PASSWORD"],
    expectedCommandFragments: ["scripts/check-linked-db-prereqs.mjs"],
  }),
  "check:security:invariants": packageScriptContract({
    target: "scripts/check-security-invariants.mjs",
    intendedCaller: "local developer or CI operator running the top-level trust check",
    trustModel: "security_invariants_wrapper",
    requiredTrustInputs: ["linked_db_bootstrap when schema-contract is included"],
    expectedCommandFragments: ["scripts/check-security-invariants.mjs"],
  }),
  "check:security": packageScriptContract({
    target: "npm run check:security:invariants",
    intendedCaller: "local developer or CI operator using the top-level security entrypoint",
    trustModel: "security_invariants_alias",
    requiredTrustInputs: ["same as check:security:invariants"],
    expectedCommandFragments: ["check:security:invariants"],
  }),
  "check:security:schema": packageScriptContract({
    target: "scripts/check-supabase-security.mjs",
    intendedCaller: "CI or a developer with linked Supabase CLI context",
    trustModel: "linked_schema_guardrail_wrapper",
    requiredTrustInputs: ["linked Supabase CLI context"],
    expectedCommandFragments: ["scripts/check-supabase-security.mjs"],
  }),
  "check:security:schema:local": packageScriptContract({
    target: "scripts/check-supabase-security.mjs",
    intendedCaller: "local developer verifying the linked schema contract with .env.local",
    trustModel: "linked_schema_guardrail_wrapper",
    requiredTrustInputs: ["SUPABASE_DB_PASSWORD", "supabase/.temp/project-ref", "supabase/.temp/pooler-url"],
    expectedCommandFragments: ["--env-file=.env.local", "scripts/check-supabase-security.mjs"],
  }),
  "verify:rls": packageScriptContract({
    target: "scripts/verify-phase1-rls.mjs",
    intendedCaller: "local developer validating live RLS behavior with .env.local",
    trustModel: "linked_rls_behavior_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY", "linked Supabase CLI context"],
    expectedCommandFragments: ["--env-file=.env.local", "scripts/verify-phase1-rls.mjs"],
  }),
  "verify:rls:linked": packageScriptContract({
    target: "scripts/verify-phase1-rls.mjs",
    intendedCaller: "CI or a developer validating live RLS behavior against the linked project",
    trustModel: "linked_rls_behavior_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY", "linked Supabase CLI context"],
    expectedCommandFragments: ["scripts/verify-phase1-rls.mjs"],
  }),
  "ebay:deletion-setup": packageScriptContract({
    target: "scripts/ebay-deletion-setup.mjs",
    intendedCaller: "trusted operator bootstrapping the eBay deletion webhook handshake values",
    trustModel: "manual_webhook_bootstrap",
    requiredTrustInputs: ["NEXT_PUBLIC_SITE_URL or VERCEL_URL", "EBAY_VERIFICATION_TOKEN"],
    expectedCommandFragments: ["scripts/ebay-deletion-setup.mjs"],
  }),
  "env:pull-safe": packageScriptContract({
    target: "scripts/safe-env-pull.ps1",
    intendedCaller: "trusted local developer syncing env vars from Vercel into .env.local",
    trustModel: "manual_env_bootstrap",
    requiredTrustInputs: ["vercel CLI auth", "write access to .env.local"],
    expectedCommandFragments: ["scripts/safe-env-pull.ps1"],
  }),
  "sets:backfill-summaries": packageScriptContract({
    target: "scripts/backfill-set-summaries.mjs",
    intendedCaller: "trusted operator running a direct service-role set-summary backfill",
    trustModel: "service_role_backfill_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/backfill-set-summaries.mjs"],
  }),
  "import:scrydex-all": packageScriptContract({
    target: "scripts/import-all-scrydex-canonical.mjs",
    intendedCaller: "trusted operator driving the Scrydex admin import route",
    trustModel: "manual_admin_route_driver_wrapper",
    requiredTrustInputs: ["ADMIN_SECRET"],
    expectedCommandFragments: ["scripts/import-all-scrydex-canonical.mjs"],
  }),
  "import:scrydex-missing-printings": packageScriptContract({
    target: "scripts/import-scrydex-canonical-direct.mjs",
    intendedCaller: "trusted operator running a direct privileged Scrydex import for missing printings",
    trustModel: "service_role_import_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/import-scrydex-canonical-direct.mjs", "--only-missing"],
  }),
  "report:set-efficiency": packageScriptContract({
    target: "scripts/report-set-efficiency.mjs",
    intendedCaller: "trusted operator generating privileged set-efficiency reports",
    trustModel: "service_role_report_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/report-set-efficiency.mjs"],
  }),
  "justtcg:repair-sweep": packageScriptContract({
    target: "scripts/sweep-justtcg-finish-repair.mjs",
    intendedCaller: "trusted operator sweeping JustTCG repairs through cron/debug flows",
    trustModel: "manual_hybrid_route_driver_wrapper",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/sweep-justtcg-finish-repair.mjs"],
  }),
  "justtcg:backfill-live": packageScriptContract({
    target: "scripts/backfill-justtcg-live.mjs",
    intendedCaller: "trusted operator running a deprecated JustTCG live backfill wrapper",
    trustModel: "manual_cron_route_driver_wrapper",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/backfill-justtcg-live.mjs"],
    status: "deprecated",
    notes: "Legacy wrapper for the retired sync-justtcg-prices flow.",
  }),
  "watch:unknown-finishes": packageScriptContract({
    target: "scripts/watch-unknown-finishes.mjs",
    intendedCaller: "trusted operator running a privileged finish diagnostic watcher",
    trustModel: "service_role_diagnostic_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/watch-unknown-finishes.mjs"],
  }),
  "ai:refresh-embeddings": packageScriptContract({
    target: "scripts/refresh-card-embeddings.mjs",
    intendedCaller: "trusted operator refreshing embeddings with service-role access",
    trustModel: "service_role_backfill_wrapper",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedCommandFragments: ["scripts/refresh-card-embeddings.mjs"],
  }),
};

export const PRIVILEGED_WORKFLOW_CONTRACTS = {
  ".github/workflows/ci.yml": privilegedEntrypoint({
    type: "ci_guardrail_workflow",
    intendedCaller: "GitHub Actions on push and pull_request",
    trustModel: "ci_repo_checks_plus_linked_schema_guardrails",
    requiredTrustInputs: ["SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD"],
    expectedSignals: ["github_actions_secrets", "security_invariants_ci", "linked_rls_ci"],
  }),
  ".github/workflows/psa-ingest-cron.yml": privilegedEntrypoint({
    type: "scheduled_internal_automation_workflow",
    intendedCaller: "GitHub Actions schedule or manual dispatch calling an internal ingest route",
    trustModel: "cron_secret_route_call",
    requiredTrustInputs: ["INGEST_URL", "CRON_SECRET", "VERCEL_AUTOMATION_BYPASS_SECRET"],
    expectedSignals: ["github_actions_secrets", "cron_secret_call"],
  }),
  ".github/workflows/supabase-migrations.yml": privilegedEntrypoint({
    type: "schema_deploy_workflow",
    intendedCaller: "GitHub Actions applying Supabase migrations on main",
    trustModel: "linked_supabase_schema_apply",
    requiredTrustInputs: ["SUPABASE_PROJECT_REF", "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD"],
    expectedSignals: ["github_actions_secrets", "supabase_migration_apply"],
  }),
};

function internalAdminSessionRoute(intendedCaller, authSourceFiles) {
  return {
    registryKind: "admin",
    trustModel: "internal_admin_session",
    uiBacked: true,
    intendedCaller,
    authSourceFiles,
  };
}

function adminSecretRoute(intendedCaller) {
  return {
    registryKind: "admin",
    trustModel: "admin_secret",
    uiBacked: false,
    intendedCaller,
  };
}

function cronSecretRoute(intendedCaller) {
  return {
    registryKind: "cron",
    trustModel: "cron_secret",
    uiBacked: false,
    intendedCaller,
  };
}

function debugCronRoute(intendedCaller, shouldStayRoute = true) {
  return {
    registryKind: "debug",
    trustModel: "debug_cron_guard",
    uiBacked: false,
    intendedCaller,
    shouldStayRoute,
  };
}

export const INTERNAL_ROUTE_TRUST_CONTRACTS = {
  "admin/ebay-deletion-tasks": internalAdminSessionRoute(
    "internal admin review UI",
    ["lib/ebay/deletion-review-routes.ts", "lib/ebay/deletion-review-admin-api.ts"],
  ),
  "admin/ebay-deletion-tasks/[id]": internalAdminSessionRoute(
    "internal admin review UI",
    ["lib/ebay/deletion-review-routes.ts", "lib/ebay/deletion-review-admin-api.ts"],
  ),
  "admin/discover-sets": adminSecretRoute("manual admin on-demand set discovery trigger"),
  "admin/import/printings": adminSecretRoute("manual admin/import tooling"),
  "admin/import/scrydex-canonical": adminSecretRoute("manual admin/import tooling"),
  "admin/psa-seeds": adminSecretRoute("manual admin seeding tooling"),
  "cron/backfill-scrydex-price-history": cronSecretRoute("cron/internal automation"),
  "cron/capture-matching-quality": cronSecretRoute("cron/internal automation"),
  "cron/capture-pricing-transparency": cronSecretRoute("cron/internal automation"),
  "cron/check-fx-rates-health": cronSecretRoute("cron/internal automation"),
  "cron/ingest-fx-rates": cronSecretRoute("cron/internal automation"),
  "cron/process-ebay-deletion-receipts": cronSecretRoute("cron/internal automation"),
  "cron/process-provider-pipeline-jobs": cronSecretRoute("cron/internal automation"),
  "cron/refresh-ai-brief": cronSecretRoute("cron/internal automation"),
  "cron/refresh-card-profiles": cronSecretRoute("cron/internal automation"),
  "cron/downsample-price-history": cronSecretRoute("cron/internal automation"),
  "cron/refresh-card-embeddings": cronSecretRoute("cron/internal automation"),
  "cron/refresh-card-image-embeddings": cronSecretRoute("cron/internal automation"),
  "cron/keepwarm-image-embedder": cronSecretRoute("cron/internal automation"),
  "cron/refresh-card-metrics": cronSecretRoute("cron/internal automation"),
  "cron/batch-refresh-pipeline-rollups": cronSecretRoute("cron/internal automation"),
  "cron/refresh-derived-signals": cronSecretRoute("cron/internal automation"),
  "cron/refresh-set-summaries": cronSecretRoute("cron/internal automation"),
  "cron/run-scrydex-daily/[chunk]": cronSecretRoute("cron/internal automation"),
  "cron/run-scrydex-2024plus-catchup": cronSecretRoute("cron/internal automation"),
  "cron/run-scrydex-2024plus-daily/[chunk]": cronSecretRoute("cron/internal automation"),
  "cron/run-scrydex-pipeline": cronSecretRoute("cron/internal automation"),
  "cron/run-scrydex-retry": cronSecretRoute("cron/internal automation"),
  "cron/snapshot-price-history": cronSecretRoute("cron/internal automation"),
  "cron/sync-canonical": cronSecretRoute("cron/internal automation"),
  "cron/sync-tcg-prices": cronSecretRoute("cron/internal automation"),
  "cron/write-provider-timeseries": cronSecretRoute("cron/internal automation"),
  "cron/prune-old-data": cronSecretRoute("cron/internal automation"),
  "cron/mirror-card-images": cronSecretRoute("cron/internal automation"),
  "cron/compute-daily-top-movers": cronSecretRoute("cron/internal automation"),
  "cron/discover-new-sets": cronSecretRoute("cron/internal automation"),
};

export const DEBUG_ROUTE_TRUST_CONTRACTS = {
  "debug/asset-inspect": debugCronRoute("internal diagnostic requests and operator troubleshooting"),
  "debug/market-summary": debugCronRoute("internal diagnostic requests and cache verification"),
  "debug/provider-price-readings": debugCronRoute("internal diagnostic requests and operator troubleshooting"),
  "debug/tracked-assets": debugCronRoute("internal diagnostic requests and operator troubleshooting"),
  "debug/tracked-assets/seed": debugCronRoute("internal seeding and repair tooling"),
  "debug/tracked-refresh-diagnostics": debugCronRoute("internal diagnostic requests and operator troubleshooting"),
  "debug/pipeline-health": debugCronRoute("internal diagnostic requests and operator troubleshooting"),
};

export const PUBLIC_WRITE_ROUTE_CONTRACTS = {
  "cards/[slug]/view": {
    routeClass: "public",
    access: "anon_or_authenticated",
    methods: ["POST"],
    writeType: "append_only_internal_table",
    abuseControls: ["ip_burst", "slug_fingerprint", "cross_site_screen", "structured_logging"],
    dbContract: "server-only insert into public.card_page_views via dbAdmin()",
    recommendedAction: "keep public route; do not re-expose public.record_card_page_view(text)",
  },
  "ebay/deletion-notification": {
    routeClass: "ingest",
    access: "webhook",
    methods: ["POST"],
    writeType: "webhook_receiver",
    abuseControls: ["ip_burst", "ebay_jws_verification", "verified_receipt_quarantine", "structured_logging"],
    dbContract: "server-only insert into public.ebay_deletion_notification_receipts after verified signature",
    recommendedAction: "keep quarantine-first; do not trigger destructive deletion work directly from the webhook route",
  },
  "personalization/events": {
    routeClass: "public",
    access: "anon_or_authenticated",
    methods: ["POST"],
    writeType: "append_only_internal_table",
    abuseControls: ["ip_burst", "actor_fingerprint", "cross_site_screen", "structured_logging"],
    dbContract: "server-only insert into public.personalization_behavior_events via dbAdmin()",
    recommendedAction: "keep server-only; do not expose public insert policy or widen grants",
  },
  "scan/identify": {
    routeClass: "public",
    access: "anon_or_authenticated",
    methods: ["POST"],
    writeType: "append_only_telemetry_plus_storage_upload_plus_vector_lookup",
    abuseControls: ["payload_size_limit_3mb", "structured_logging"],
    dbContract:
      "uploads uploaded JPEG to Supabase Storage card-images bucket under scan-uploads/<sha256>.jpg (keyed by image hash — idempotent), passes the resulting public URL to Replicate for embedding, runs readonly pgvector kNN against Neon card_image_embeddings, and inserts a single telemetry row into public.scan_identify_events via dbAdmin(). Only the sha256 hash is stored in telemetry.",
    recommendedAction:
      "keep telemetry writes append-only; never expose scan_identify_events to anon/authenticated readers without a privacy review. Add a bucket lifecycle rule to auto-delete scan-uploads/* objects after a short TTL when volume warrants.",
  },
  waitlist: {
    routeClass: "public",
    access: "anon_or_authenticated",
    methods: ["POST"],
    writeType: "insert_only_public_table",
    abuseControls: ["ip_burst", "submission_fingerprint", "honeypot", "form_age_check", "structured_logging"],
    dbContract: "public.waitlist_signups INSERT only",
    recommendedAction: "keep insert-only; do not broaden to public upsert/select/update",
  },
};

export const PUBLIC_CALLABLE_FUNCTION_CONTRACTS = {
  "is_handle_available(text)": {
    roles: ["anon", "authenticated"],
    writeType: "read_only_lookup",
    recommendedAction: "keep public execute narrow and read-only",
  },
  "requesting_clerk_user_id()": {
    roles: ["authenticated"],
    writeType: "identity_helper",
    recommendedAction: "keep authenticated-only; never expose to anon",
  },
  "resolve_profile_handle(text)": {
    roles: ["authenticated"],
    writeType: "read_only_lookup",
    recommendedAction: "keep authenticated-only because it backs user-scoped profile follow flows",
  },
};

function operationalScript({
  classification,
  executionMode,
  intendedCaller,
  requiredTrustInputs,
  expectedSignals,
  usesServiceRole = false,
  shouldStayScript = true,
  status = "active",
  notes = null,
}) {
  return {
    classification,
    executionMode,
    intendedCaller,
    requiredTrustInputs,
    expectedSignals,
    usesServiceRole,
    shouldStayScript,
    status,
    notes,
  };
}

export const OPERATIONAL_SCRIPT_TRUST_CONTRACTS = {
  "scripts/check-linked-db-prereqs.mjs": operationalScript({
    classification: "linked_db_bootstrap",
    executionMode: "bootstrap",
    intendedCaller: "local developer or CI operator validating linked Supabase prerequisites",
    requiredTrustInputs: ["supabase_linked_cli", "SUPABASE_DB_PASSWORD"],
    expectedSignals: ["linked_db_helper"],
    usesServiceRole: false,
  }),
  "scripts/check-supabase-security.mjs": operationalScript({
    classification: "linked_db_guardrail",
    executionMode: "verification",
    intendedCaller: "security invariants and schema guardrail runs",
    requiredTrustInputs: ["supabase_linked_cli", "SUPABASE_DB_PASSWORD"],
    expectedSignals: ["linked_db_helper"],
    usesServiceRole: false,
  }),
  "scripts/verify-phase1-rls.mjs": operationalScript({
    classification: "linked_db_verification",
    executionMode: "verification",
    intendedCaller: "security verification runs proving public/private RLS contracts",
    requiredTrustInputs: ["supabase_linked_cli", "SUPABASE_DB_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["linked_db_helper", "service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/ebay-deletion-setup.mjs": operationalScript({
    classification: "manual_security_bootstrap",
    executionMode: "manual_bootstrap",
    intendedCaller: "trusted operator preparing eBay deletion webhook handshake values",
    requiredTrustInputs: ["EBAY_VERIFICATION_TOKEN", "NEXT_PUBLIC_SITE_URL or VERCEL_URL"],
    expectedSignals: ["ebay_verification_bootstrap"],
    usesServiceRole: false,
  }),
  "scripts/safe-env-pull.ps1": operationalScript({
    classification: "local_env_bootstrap",
    executionMode: "manual_bootstrap",
    intendedCaller: "trusted local developer syncing Vercel env vars into .env.local",
    requiredTrustInputs: ["vercel_cli_auth", "local_env_write_access"],
    expectedSignals: ["vercel_env_pull"],
    usesServiceRole: false,
  }),
  "scripts/backfill-all-sets.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator running direct set backfills from a local shell",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/backfill-justtcg-live.mjs": operationalScript({
    classification: "manual_cron_route_driver",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator running legacy JustTCG live backfills",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["cron_secret_route_driver", "service_role_client"],
    usesServiceRole: true,
    status: "deprecated",
    notes: "Targets the retired sync-justtcg-prices flow and should be replaced before reuse.",
  }),
  "scripts/backfill-justtcg-sealed.mjs": operationalScript({
    classification: "manual_cron_route_driver",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator running legacy JustTCG sealed coverage sweeps",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["cron_secret_route_driver", "service_role_client"],
    usesServiceRole: true,
    status: "deprecated",
    notes: "Targets the retired sync-justtcg-prices flow and should be replaced before reuse.",
  }),
  "scripts/backfill-pass2.mjs": operationalScript({
    classification: "manual_cron_route_driver",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator running a one-off JustTCG repair pass",
    requiredTrustInputs: ["CRON_SECRET"],
    expectedSignals: ["cron_secret_route_driver"],
    usesServiceRole: false,
    status: "deprecated",
    shouldStayScript: false,
    notes: "Legacy pass-two repair helper; keep out of normal workflows until it is replaced or removed.",
  }),
  "scripts/backfill-search-normalization.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator backfilling search normalization data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/backfill-set-summaries.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator backfilling set summary snapshots",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/bulk-downsample-price-history.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator running a one-shot bulk downsample of price_history_points to shrink the table after the 2026-04-16 incident",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/bulk-prune-old-price-history.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator hard-deleting price_history_points rows past 90-day retention to drain the backlog the 5000/day cron can't keep up with (2026-04-16 incident Phase 3)",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/backfill-unpriced-sets.mjs": operationalScript({
    classification: "manual_hybrid_route_driver",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator repairing missing price history via debug routes plus direct DB reads",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["cron_secret_route_driver", "service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/check-2025-sets.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator running one-off catalog diagnostics",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/debug-coverage.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator inspecting provider mapping coverage",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/fetch-justtcg-raw.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator fetching raw JustTCG payload samples into the database",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/fill-scrydex-history-gaps.mjs": operationalScript({
    classification: "service_role_repair",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator forward-filling missing Scrydex snapshot days from existing privileged history data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/import-all-scrydex-canonical.mjs": operationalScript({
    classification: "manual_admin_route_driver",
    executionMode: "manual_import",
    intendedCaller: "trusted operator driving the Scrydex canonical admin import route",
    requiredTrustInputs: ["ADMIN_SECRET"],
    expectedSignals: ["admin_secret_route_driver"],
    usesServiceRole: false,
  }),
  "scripts/import-justtcg-signals.mjs": operationalScript({
    classification: "manual_cron_route_driver",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator driving legacy JustTCG signal refresh routes",
    requiredTrustInputs: ["CRON_SECRET"],
    expectedSignals: ["cron_secret_route_driver"],
    usesServiceRole: false,
    status: "deprecated",
    notes: "Targets the retired sync-justtcg-prices flow and should be replaced before reuse.",
  }),
  "scripts/import-pokemon-tcg-data-local.mjs": operationalScript({
    classification: "service_role_import",
    executionMode: "manual_import",
    intendedCaller: "trusted operator importing local Pokemon TCG data directly into Supabase",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/import-scrydex-canonical-direct.mjs": operationalScript({
    classification: "service_role_import",
    executionMode: "manual_import",
    intendedCaller: "trusted operator importing Scrydex canonical data directly into Supabase",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/map-pokemon-tcg-api-sets.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator mapping Pokemon TCG API sets against internal data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/rebuild-scrydex-raw-timeseries.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator rebuilding Scrydex raw timeseries data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/refresh-card-embeddings.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator refreshing card embeddings with privileged DB access",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/refresh-market-rollups-batched.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator refreshing market rollups in batched runs",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/repair-broken-card-images.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator repairing card_printings / canonical_cards rows whose pokemontcg.io image URLs 404 — swaps in Scrydex URLs and re-mirrors into Supabase Storage",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY", "SCRYDEX_API_KEY", "SCRYDEX_TEAM_ID"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
    notes: "One-off repair tool with a --dry-run mode; scope is narrow (only rows whose image_url is null or mirror last-error mentions 404).",
  }),
  "scripts/report-scrydex-set-history-coverage.mjs": operationalScript({
    classification: "service_role_report",
    executionMode: "manual_report",
    intendedCaller: "trusted operator reporting Scrydex set history coverage from privileged data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/report-set-efficiency.mjs": operationalScript({
    classification: "service_role_report",
    executionMode: "manual_report",
    intendedCaller: "trusted operator generating set efficiency reports from privileged data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/run-live-normalizer-smoke.mjs": operationalScript({
    classification: "manual_hybrid_route_driver",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator smoke-testing live normalization flows against admin routes and direct DB state",
    requiredTrustInputs: ["ADMIN_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["admin_secret_route_driver", "service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/run-provider-normalize-direct.mjs": operationalScript({
    classification: "service_role_repair",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator running provider normalization directly against Supabase",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/run-refresh-rpc-benchmarks.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator benchmarking privileged refresh RPCs",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/seed-scout-summaries.mjs": operationalScript({
    classification: "service_role_backfill",
    executionMode: "manual_backfill",
    intendedCaller: "trusted operator seeding scout summaries with privileged DB access",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/sweep-justtcg-finish-repair.mjs": operationalScript({
    classification: "manual_hybrid_route_driver",
    executionMode: "manual_repair",
    intendedCaller: "trusted operator sweeping JustTCG finish repairs through debug routes and privileged DB checks",
    requiredTrustInputs: ["CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["cron_secret_route_driver", "service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/verify-justtcg-mapping-200.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator verifying JustTCG mapping samples from privileged data",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
  "scripts/verify-market-summary-cache.mjs": operationalScript({
    classification: "manual_cron_route_driver",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator checking legacy market summary cache flows",
    requiredTrustInputs: ["CRON_SECRET"],
    expectedSignals: ["cron_secret_route_driver"],
    usesServiceRole: false,
    status: "deprecated",
    notes: "Targets the retired sync-justtcg-prices flow and should be replaced before reuse.",
  }),
  "scripts/watch-unknown-finishes.mjs": operationalScript({
    classification: "service_role_diagnostic",
    executionMode: "manual_diagnostic",
    intendedCaller: "trusted operator watching unknown finish diagnostics",
    requiredTrustInputs: ["SUPABASE_SERVICE_ROLE_KEY"],
    expectedSignals: ["service_role_client"],
    usesServiceRole: true,
  }),
};

export const PHASE2_INTERNAL_OPERATIONAL_TABLES = [
  "card_embeddings",
  "card_external_mappings",
  "deck_aliases",
  "decks",
  "ingest_runs",
  "listing_observations",
  "market_events",
  "market_observations",
  "matching_quality_audits",
  "outlier_excluded_points",
  "pipeline_jobs",
  "price_snapshots",
  "pricing_alert_events",
  "tracked_assets",
  "tracked_refresh_diagnostics",
];

export const PHASE2_PROVIDER_AND_MAPPING_TABLES = [
  "label_normalization_rules",
  "provider_card_map",
  "provider_ingests",
  "provider_normalized_observations",
  "provider_observation_matches",
  "provider_raw_payload_lineages",
  "provider_raw_payloads",
  "provider_set_health",
  "provider_set_map",
];

export const PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES = [
  "psa_cert_cache",
  "psa_cert_lookup_logs",
  "psa_certificates",
  "psa_seed_certs",
  "realized_sales_backtest_snapshots",
];

export const PHASE2_PUBLIC_WRITE_TABLES = [
  "waitlist_signups",
  "card_page_views",
];

export const PHASE2_DIRECT_PUBLIC_READ_TABLES = [
  "canonical_cards",
  "card_aliases",
  "card_printings",
  "card_profiles",
  "deck_cards",
  "fx_rates",
  "printing_aliases",
];

export const PHASE2_INTERNAL_BASE_VIEW_TABLES = [
  "card_metrics",
  "market_latest",
  "price_history",
  "price_history_points",
  "psa_cert_snapshots",
  "set_finish_summary_latest",
  "set_summary_snapshots",
  "variant_metrics",
  "variant_price_daily",
  "variant_price_latest",
  "variant_sentiment_latest",
  "variant_signals_latest",
];

export const PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES = [
  "canonical_raw_provider_parity",
  "market_snapshots",
  "pricing_transparency_snapshots",
];

export const PHASE3_PUBLIC_SELECT_ONLY_VIEWS = [
  "canonical_set_catalog",
  "public_card_metrics",
  "public_card_page_view_daily",
  "public_card_page_view_totals",
  "public_community_vote_totals",
  "public_market_latest",
  "public_price_history",
  "public_profile_post_mentions",
  "public_profile_posts",
  "public_profile_social_stats",
  "public_psa_snapshots",
  "public_set_finish_summary",
  "public_set_summaries",
  "public_user_profiles",
  "public_variant_metrics",
  "public_variant_movers",
  "public_variant_movers_priced",
];

export const PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS = [
  "community_user_vote_weeks",
  "community_vote_feed_events",
];

export const PHASE3_INTERNAL_NO_GRANT_VIEWS = [
  "market_snapshot_rollups",
  "pro_card_metrics",
  "pro_variant_metrics",
];

export const PHASE3_VIEW_AND_PAYWALLED_OBJECTS = [
  ...PHASE3_PUBLIC_SELECT_ONLY_VIEWS,
  ...PHASE3_AUTHENTICATED_SELECT_ONLY_VIEWS,
  ...PHASE3_INTERNAL_NO_GRANT_VIEWS,
];

export const RLS_REQUIRED_PUBLIC_TABLES = [
  "app_users",
  ...PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES,
  ...PHASE2_INTERNAL_OPERATIONAL_TABLES,
  ...PHASE2_PROVIDER_AND_MAPPING_TABLES,
  ...PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES,
  ...PHASE2_PUBLIC_WRITE_TABLES,
  ...PHASE2_DIRECT_PUBLIC_READ_TABLES,
  ...PHASE2_INTERNAL_BASE_VIEW_TABLES,
  "apns_device_tokens",
  "community_card_votes",
  "ebay_deletion_manual_review_events",
  "ebay_deletion_manual_review_tasks",
  "ebay_deletion_notification_receipts",
  "holdings",
  "market_snapshots",
  "personalization_actor_claims",
  "personalization_behavior_events",
  "personalization_explanation_cache",
  "personalization_profiles",
  "pricing_transparency_snapshots",
  "private_sales",
  "profile_follows",
  "profile_post_card_mentions",
  "profile_posts",
  "push_subscriptions",
];

export const RLS_EXEMPT_PUBLIC_TABLES = [
];

function rlsRolloutBatch({
  phase,
  migrationName,
  accessModel,
  tables,
  verification,
}) {
  return {
    phase,
    migrationName,
    accessModel,
    tables,
    verification,
  };
}

export const RLS_ROLLOUT_BATCHES = [
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_internal_operational_tables_rls",
    accessModel: "internal_service_only",
    tables: PHASE2_INTERNAL_OPERATIONAL_TABLES,
    verification: "Enable RLS, keep anon/authenticated grants empty, and prove anon/authenticated cannot SELECT any row.",
  }),
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_provider_and_mapping_tables_rls",
    accessModel: "internal_service_only",
    tables: PHASE2_PROVIDER_AND_MAPPING_TABLES,
    verification: "Enable RLS, keep anon/authenticated grants empty, and prove public/debug callers cannot read provider internals without dbAdmin().",
  }),
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_reference_and_psa_internal_tables_rls",
    accessModel: "internal_service_only",
    tables: PHASE2_REFERENCE_AND_PSA_INTERNAL_TABLES,
    verification: "Enable RLS, keep anon/authenticated grants empty, and verify only internal/admin paths retain access.",
  }),
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_public_write_tables_rls",
    accessModel: "write_only_public_or_internal_ingest",
    tables: PHASE2_PUBLIC_WRITE_TABLES,
    verification: "Enable RLS, keep waitlist insert-only for anon/authenticated, keep card_page_views internal-only, and verify direct public SELECT still fails.",
  }),
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_direct_public_read_tables_rls",
    accessModel: "public_read",
    tables: PHASE2_DIRECT_PUBLIC_READ_TABLES,
    verification: "Enable RLS with anon/authenticated SELECT policies using USING (true), keep write grants revoked, and verify anon reads still work.",
  }),
  rlsRolloutBatch({
    phase: "phase2",
    migrationName: "phase2_internal_bases_backing_public_views_rls",
    accessModel: "internal_base_backing_public_views",
    tables: PHASE2_INTERNAL_BASE_VIEW_TABLES,
    verification: "Enable RLS, keep anon/authenticated grants empty on the base tables, and verify public_* views still satisfy the public contract.",
  }),
  rlsRolloutBatch({
    phase: "phase3",
    migrationName: "phase3_existing_rls_public_internal_write_grant_cleanup",
    accessModel: "public_read_internal_write",
    tables: PHASE3_EXISTING_PUBLIC_READ_INTERNAL_WRITE_TABLES,
    verification: "Do not change rowsecurity state; tighten grants so anon/authenticated remain SELECT-only while dbAdmin() retains internal writes.",
  }),
  rlsRolloutBatch({
    phase: "phase3",
    migrationName: "phase3_view_and_paywalled_surface_cleanup",
    accessModel: "public_read_authenticated_read_internal_no_grant_views",
    tables: PHASE3_VIEW_AND_PAYWALLED_OBJECTS,
    verification: "Reassert SELECT-only grants on public/authenticated views, keep internal/paywalled views off anon/authenticated, and verify public_* view reads still work.",
  }),
];

export const AUTHENTICATED_DML_OBJECT_GRANTS = {
  apns_device_tokens: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  app_users: ["INSERT", "SELECT", "UPDATE"],
  community_card_votes: ["INSERT", "SELECT"],
  holdings: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  personalization_profiles: ["SELECT"],
  private_sales: ["DELETE", "INSERT", "SELECT"],
  profile_follows: ["DELETE", "INSERT", "SELECT"],
  profile_post_card_mentions: ["DELETE", "INSERT", "SELECT"],
  profile_posts: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  push_subscriptions: ["DELETE", "INSERT", "SELECT", "UPDATE"],
};

export const AUTHENTICATED_SELECT_ONLY_OBJECTS = [
  "community_user_vote_weeks",
  "community_vote_feed_events",
];

export const PUBLIC_SELECT_ONLY_OBJECTS = [
  "canonical_cards",
  "canonical_raw_provider_parity",
  "canonical_set_catalog",
  "card_aliases",
  "card_printings",
  "card_profiles",
  "deck_cards",
  "fx_rates",
  "market_snapshots",
  "pricing_transparency_snapshots",
  "printing_aliases",
  "public_card_metrics",
  "public_card_page_view_daily",
  "public_card_page_view_totals",
  "public_community_vote_totals",
  "public_market_latest",
  "public_price_history",
  "public_profile_post_mentions",
  "public_profile_posts",
  "public_profile_social_stats",
  "public_psa_snapshots",
  "public_set_finish_summary",
  "public_set_summaries",
  "public_user_profiles",
  "public_variant_metrics",
  "public_variant_movers",
  "public_variant_movers_priced",
];

export const WRITE_ONLY_PUBLIC_OBJECT_GRANTS = {
  waitlist_signups: ["INSERT"],
};

export const SEQUENCE_GRANT_CONTRACTS = {
  card_page_views_id_seq: {
    anon: [],
    authenticated: [],
  },
  community_card_votes_id_seq: {
    anon: [],
    authenticated: ["USAGE"],
  },
  matching_quality_audits_id_seq: {
    anon: [],
    authenticated: [],
  },
  outlier_excluded_points_id_seq: {
    anon: [],
    authenticated: [],
  },
  personalization_behavior_events_id_seq: {
    anon: [],
    authenticated: [],
  },
  personalization_explanation_cache_id_seq: {
    anon: [],
    authenticated: [],
  },
  pipeline_jobs_id_seq: {
    anon: [],
    authenticated: [],
  },
  pricing_alert_events_id_seq: {
    anon: [],
    authenticated: [],
  },
  pricing_transparency_snapshots_id_seq: {
    anon: [],
    authenticated: [],
  },
  profile_post_card_mentions_id_seq: {
    anon: [],
    authenticated: ["USAGE"],
  },
  profile_posts_id_seq: {
    anon: [],
    authenticated: ["USAGE"],
  },
  psa_cert_lookup_logs_id_seq: {
    anon: [],
    authenticated: [],
  },
  push_subscriptions_id_seq: {
    anon: [],
    authenticated: ["USAGE"],
  },
  apns_device_tokens_id_seq: {
    anon: [],
    authenticated: ["USAGE"],
  },
  realized_sales_backtest_snapshots_id_seq: {
    anon: [],
    authenticated: [],
  },
  waitlist_signups_id_seq: {
    anon: ["USAGE"],
    authenticated: ["USAGE"],
  },
};

export const INTERNAL_NO_GRANT_OBJECTS = [
  "card_embeddings",
  "card_external_mappings",
  "card_metrics",
  "card_page_views",
  "ebay_deletion_manual_review_events",
  "ebay_deletion_manual_review_tasks",
  "ebay_deletion_notification_receipts",
  "deck_aliases",
  "decks",
  "ingest_runs",
  "label_normalization_rules",
  "listing_observations",
  "market_events",
  "market_latest",
  "market_observations",
  "market_snapshot_rollups",
  "matching_quality_audits",
  "outlier_excluded_points",
  "personalization_actor_claims",
  "personalization_behavior_events",
  "personalization_explanation_cache",
  "pipeline_jobs",
  "price_history",
  "price_history_points",
  "price_snapshots",
  "pricing_alert_events",
  "pro_card_metrics",
  "pro_variant_metrics",
  "provider_card_map",
  "provider_ingests",
  "provider_normalized_observations",
  "provider_observation_matches",
  "provider_raw_payload_lineages",
  "provider_raw_payloads",
  "provider_set_health",
  "provider_set_map",
  "psa_cert_cache",
  "psa_cert_lookup_logs",
  "psa_cert_snapshots",
  "psa_certificates",
  "psa_seed_certs",
  "realized_sales_backtest_snapshots",
  "set_finish_summary_latest",
  "set_summary_snapshots",
  "tracked_assets",
  "tracked_refresh_diagnostics",
  "variant_metrics",
  "variant_price_daily",
  "variant_price_latest",
  "variant_sentiment_latest",
  "variant_signals_latest",
];

export const PUBLIC_VIEW_NAMES = [
  "canonical_set_catalog",
  "community_user_vote_weeks",
  "community_vote_feed_events",
  "market_snapshot_rollups",
  "pro_card_metrics",
  "pro_variant_metrics",
  "public_card_metrics",
  "public_card_page_view_daily",
  "public_card_page_view_totals",
  "public_community_vote_totals",
  "public_market_latest",
  "public_price_history",
  "public_profile_post_mentions",
  "public_profile_posts",
  "public_profile_social_stats",
  "public_psa_snapshots",
  "public_set_finish_summary",
  "public_set_summaries",
  "public_user_profiles",
  "public_variant_metrics",
  "public_variant_movers",
  "public_variant_movers_priced",
];

export const PHASE1_PRIVATE_TABLES = [
  "apns_device_tokens",
  "app_users",
  "holdings",
  "private_sales",
  "profile_follows",
  "profile_post_card_mentions",
  "profile_posts",
  "push_subscriptions",
];

export const SECURITY_INVOKER_VIEWS = [
  "community_user_vote_weeks",
  "community_vote_feed_events",
];

export const PUBLIC_FUNCTION_EXECUTE_ALLOWLIST = Object.fromEntries(
  Object.entries(PUBLIC_CALLABLE_FUNCTION_CONTRACTS).map(([signature, contract]) => [
    signature,
    [...contract.roles],
  ]),
);

export const PUBLIC_SCHEMA_EVENT_TRIGGER = "popalpha_auto_enable_public_table_rls";

export const FIXED_ROUTE_CLASSIFICATIONS = {
  "admin/ebay-deletion-tasks": "admin",
  "admin/ebay-deletion-tasks/[id]": "admin",
  "cron/process-ebay-deletion-receipts": "cron",
  "ebay/deletion-notification": "ingest",
};

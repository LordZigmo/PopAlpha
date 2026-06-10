/**
 * scripts/setup-posthog-launch-monitoring.mjs
 *
 * One-shot creation of the launch-week monitoring surface in PostHog
 * (post-launch ticket C1 from the launch audit):
 *
 *   1. "PopAlpha Launch Health" dashboard with five tiles:
 *      - Pro entitlement check failures  (entitlement_check_failed)
 *      - Scan outcomes by confidence     (card_scanned ⧸ confidence)
 *      - Paywall funnel                  (viewed → subscribe tapped → subscribed)
 *      - Free insight budget burn        (free_analysis_revealed ⧸ seen_count)
 *      - Bulk import health              (holdings_bulk_imported sums)
 *   2. An hourly alert on entitlement_check_failed > 0 — that event
 *      should be permanently zero; any signal means paying users are
 *      being locked out of Pro surfaces (lib/entitlements.ts fails
 *      closed on DB errors).
 *
 * Usage (from a machine with network access to PostHog):
 *   1. Create a personal API key: PostHog → Settings → Personal API keys
 *      → Create key. Minimum scopes: insight:write, dashboard:write,
 *      alert:write (or just use "All access" and delete the key after).
 *   2. POSTHOG_PERSONAL_API_KEY=phx_... node scripts/setup-posthog-launch-monitoring.mjs
 *
 * Optional env:
 *   POSTHOG_HOST        (default https://us.posthog.com)
 *   POSTHOG_PROJECT_ID  (skips token-based project discovery)
 *
 * Idempotent-by-refusal: if the dashboard name already exists the
 * script stops and prints its URL instead of creating duplicates.
 * The alert API is newer surface area than insights/dashboards — if
 * that single call fails, the script prints the 3-click manual path
 * with a direct link rather than failing the whole run.
 */

const HOST = (process.env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "");
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;

// The app's project (capture) token — same value hardcoded in
// ios/AnalyticsService.swift and set as NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
// on Vercel. Used only to FIND the right project; it cannot authenticate
// this script.
const PROJECT_CAPTURE_TOKEN = "phc_sCBhLBr4jbxrgXkWXSdUCEz2J9SVva9u7kqa96LU4DBu";

const DASHBOARD_NAME = "PopAlpha Launch Health";
const ALERT_INSIGHT_NAME = "Pro entitlement check failures";
const ALERT_NAME = "Pro entitlement lockout (entitlement_check_failed > 0)";

if (!KEY) {
  console.error("Missing POSTHOG_PERSONAL_API_KEY (create one in PostHog → Settings → Personal API keys).");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text for the error path
  }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return json;
}

async function resolveProjectId() {
  if (process.env.POSTHOG_PROJECT_ID) return process.env.POSTHOG_PROJECT_ID;
  const projects = await api("GET", "/api/projects/");
  const match = (projects.results ?? []).find((p) => p.api_token === PROJECT_CAPTURE_TOKEN);
  if (!match) {
    throw new Error(
      "Could not find a project whose capture token matches the app's. " +
      "Set POSTHOG_PROJECT_ID explicitly (PostHog → Settings → Project → Project ID).",
    );
  }
  return match.id;
}

function trends({ event, name, math = "total", mathProperty, breakdown, interval = "day", dateFrom = "-7d", extraSeries = [] }) {
  const series = [
    {
      kind: "EventsNode",
      event,
      name: name ?? event,
      math,
      ...(mathProperty ? { math_property: mathProperty } : {}),
    },
    ...extraSeries,
  ];
  return {
    kind: "InsightVizNode",
    source: {
      kind: "TrendsQuery",
      series,
      interval,
      dateRange: { date_from: dateFrom },
      ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
    },
  };
}

async function main() {
  const projectId = await resolveProjectId();
  console.log(`Project: ${projectId} @ ${HOST}`);

  // Refuse to duplicate an existing dashboard.
  const existing = await api("GET", `/api/projects/${projectId}/dashboards/?search=${encodeURIComponent(DASHBOARD_NAME)}`);
  const dupe = (existing.results ?? []).find((d) => d.name === DASHBOARD_NAME && !d.deleted);
  if (dupe) {
    console.log(`Dashboard "${DASHBOARD_NAME}" already exists: ${HOST}/project/${projectId}/dashboard/${dupe.id}`);
    console.log("Delete it in PostHog first if you want this script to recreate it.");
    return;
  }

  const dashboard = await api("POST", `/api/projects/${projectId}/dashboards/`, {
    name: DASHBOARD_NAME,
    description:
      "Launch-week health: Pro lockouts, scanner outcomes, paywall funnel, free-budget burn, bulk-import errors. " +
      "Created by scripts/setup-posthog-launch-monitoring.mjs (launch audit ticket C1).",
    pinned: true,
  });
  console.log(`Dashboard created: ${HOST}/project/${projectId}/dashboard/${dashboard.id}`);

  async function createInsight(name, description, query) {
    const insight = await api("POST", `/api/projects/${projectId}/insights/`, {
      name,
      description,
      query,
      dashboards: [dashboard.id],
      saved: true,
    });
    console.log(`  tile: ${name} (insight ${insight.id})`);
    return insight;
  }

  // 1. The alert source. Hourly grain so the alert reacts fast.
  const alertInsight = await createInsight(
    ALERT_INSIGHT_NAME,
    "hasPro() lookup failures (lib/entitlements.ts). Fails closed — every event here is a paying user " +
    "seeing a locked Pro surface. Expected to be permanently zero; alert fires on any non-zero hour.",
    trends({ event: "entitlement_check_failed", name: "entitlement_check_failed", interval: "hour", dateFrom: "-24h" }),
  );

  // 2. Scanner health.
  await createInsight(
    "Scan outcomes by confidence",
    "card_scanned broken down by confidence. Watch the 'error' share — it is the scanner failure rate; " +
    "'low' share is the auto-resume rate.",
    trends({ event: "card_scanned", breakdown: "confidence" }),
  );

  // 3. Paywall funnel.
  await createInsight(
    "Paywall funnel",
    "viewed → subscribe tapped → subscribed. For drop-off by entry point, open and break down by 'context'.",
    {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        series: [
          { kind: "EventsNode", event: "paywall_viewed", name: "paywall_viewed" },
          { kind: "EventsNode", event: "paywall_subscribe_tapped", name: "paywall_subscribe_tapped" },
          { kind: "EventsNode", event: "paywall_subscribed", name: "paywall_subscribed" },
        ],
        dateRange: { date_from: "-7d" },
        funnelsFilter: { funnelVizType: "steps" },
      },
    },
  );

  // 4. Free budget burn (ticket C4's event).
  await createInsight(
    "Free insight budget burn",
    "free_analysis_revealed broken down by seen_count (1/2/3 of the device-scoped cap). A heavy '3' share " +
    "means the cap is binding (good conversion pressure); per-person repeats at seen_count=1 after " +
    "reinstalls would indicate reset abuse.",
    trends({ event: "free_analysis_revealed", breakdown: "seen_count" }),
  );

  // 5. Bulk import health.
  await createInsight(
    "Bulk import health",
    "holdings_bulk_imported: inserted vs errored row sums. A rising errored share points at scanner-import " +
    "regressions or API instability.",
    trends({
      event: "holdings_bulk_imported",
      name: "rows inserted",
      math: "sum",
      mathProperty: "rows_inserted",
      extraSeries: [
        { kind: "EventsNode", event: "holdings_bulk_imported", name: "rows errored", math: "sum", math_property: "rows_errored" },
      ],
    }),
  );

  // 6. The alert. Newer API surface — degrade to printed instructions
  //    rather than failing the run if the shape is rejected.
  try {
    const me = await api("GET", "/api/users/@me/");
    await api("POST", `/api/projects/${projectId}/alerts/`, {
      name: ALERT_NAME,
      insight: alertInsight.id,
      subscribed_users: [me.id],
      enabled: true,
      calculation_interval: "hourly",
      config: { type: "TrendsAlertConfig", series_index: 0 },
      condition: { type: "absolute_value" },
      threshold: { configuration: { type: "absolute", bounds: { upper: 0 } } },
    });
    console.log(`Alert created: "${ALERT_NAME}" (hourly, fires when count > 0, notifies ${me.email ?? "you"})`);
  } catch (err) {
    console.warn(`Alert API call failed (${err.message}).`);
    console.warn("Manual fallback (3 clicks):");
    console.warn(`  1. Open ${HOST}/project/${projectId}/insights — "${ALERT_INSIGHT_NAME}"`);
    console.warn("  2. Alerts (bell icon) → New alert");
    console.warn("  3. When value is MORE THAN 0, checked hourly → notify yourself → Create");
  }

  console.log("\nDone. Pin check: the dashboard was created pinned; confirm it shows on your project home.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

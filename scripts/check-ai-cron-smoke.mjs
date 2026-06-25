// scripts/check-ai-cron-smoke.mjs
//
// Deploy-time guard against the silent-fallback failure class documented in
// docs/external-api-failure-modes.md (Incident 2: a Gemini deprecation made
// 498/498 card profiles silently fall back while the cron still returned
// ok:true). The remediation flips ok:false / HTTP 500 on full degradation;
// this check exercises each LLM cron with a MINIMAL batch.
//
// WHAT FAILS vs WARNS (this guard is narrow on purpose):
//   FAIL (exit 1) — ONLY the Incident-2 signature: a SUCCESSFUL-looking
//     response (HTTP 200, ok:true) that nonetheless shows the LLM never ran
//     (llmPathDegraded, or processed>0 with llmGenerated=0, or no llm-source
//     brief). That clean-200-that-lies is the silent fallback this exists to
//     catch.
//   WARN (exit 0) — everything else: non-2xx, ok:false, 401 (route CRON_SECRET
//     or Vercel Deployment Protection), transport/timeout, or no candidate.
//     These are either LOUD failures (already visible — not a silent lie) or
//     "couldn't reach a working LLM here" (e.g. a preview/CI env without live
//     AI creds). They are inconclusive for THIS guard, so they must not
//     red-flag the build.
//
// Real validation therefore requires the target env to have live AI creds: a
// creds-less env WARNs (an honest no-op) instead of false-failing. To get a
// hard signal, point it at an env that has creds (production, or a Preview
// with AI creds added).
//
// Needs a server + the cron secret, so it runs against a preview/local URL
// (SMOKE_BASE_URL); SKIPS (exit 0) when SMOKE_BASE_URL/CRON_SECRET are unset.
// Against a protected Vercel preview, also set VERCEL_AUTOMATION_BYPASS_SECRET.
// Cost: ~$0.001 (one card profile + EN/JP briefs) when it can actually run.

const baseUrl = process.env.SMOKE_BASE_URL?.replace(/\/+$/, "");
const cronSecret = process.env.CRON_SECRET?.trim();
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);

if (!baseUrl || !cronSecret) {
  console.log(
    "ai-cron smoke check SKIPPED — set SMOKE_BASE_URL and CRON_SECRET to run " +
      "(needs a server with live AI creds; not part of the static build).",
  );
  process.exit(0);
}

// Each check hits an LLM cron with a minimal batch and classifies the body.
//   fail → the Incident-2 silent lie: ok:true but the LLM never ran → exit 1
//   warn → couldn't validate here (loud failure / no creds / no data)  → exit 0
//   pass → the LLM demonstrably produced output
const CHECKS = [
  {
    name: "refresh-card-profiles",
    // refresh mode re-generates the stalest existing profile, so a 1-card
    // batch reliably has a candidate to drive the model.
    path: "/api/cron/refresh-card-profiles?mode=refresh&maxCards=1",
    assert: (b) => {
      // Loud failure (ok:false) is NOT the silent fallback this guards — it is
      // already visible. In a creds-less env it is also the expected outcome.
      if (b.ok !== true) {
        return {
          status: "warn",
          detail:
            `ok=${b.ok} (loud failure / env can't run the LLM) — not the silent fallback this guards. `
            + `llmFailureReason=${b.firstError ?? b.llmFailureReason ?? "null"} halted=${b.haltedForLlmProviderFailure}`,
        };
      }
      // ok:true below — now look for the silent lie.
      if (b.llmPathDegraded === true) {
        return {
          status: "fail",
          detail:
            `SILENT FALLBACK: ok:true but llmPathDegraded=true `
            + `(processed=${b.totalProcessed} llmGenerated=${b.llmGenerated})`,
        };
      }
      if ((b.totalProcessed ?? 0) === 0) {
        return { status: "warn", detail: "ok:true, totalProcessed=0 — no candidate to exercise the LLM (inconclusive)" };
      }
      // A low-dollar (<= $2) candidate is processed deterministically with NO
      // LLM call by design (now common in the catalog), so llmGenerated=0 there
      // is healthy, not a silent fallback. Only the case NOT explained by a
      // low-dollar skip is the silent lie this guards.
      if ((b.llmGenerated ?? 0) < 1 && (b.lowDollarSkipped ?? 0) > 0) {
        return { status: "warn", detail: `ok:true, the single candidate was a low-dollar skip (no LLM by design) — inconclusive (lowDollarSkipped=${b.lowDollarSkipped})` };
      }
      if ((b.llmGenerated ?? 0) < 1) {
        return { status: "fail", detail: `SILENT FALLBACK: ok:true + processed=${b.totalProcessed} but llmGenerated=0` };
      }
      return {
        status: "pass",
        detail: `processed=${b.totalProcessed} llmGenerated=${b.llmGenerated} outTokens=${b.totalOutputTokens}`,
      };
    },
  },
  {
    name: "refresh-ai-brief",
    // No batch param — it generates the EN + JP briefs (a fixed tiny batch).
    path: "/api/cron/refresh-ai-brief",
    assert: (b) => {
      if (b.ok !== true) {
        return {
          status: "warn",
          detail: `ok=${b.ok} (loud failure / env can't run the LLM) — not the silent fallback this guards. llmFailureReason=${b.llmFailureReason ?? "null"}`,
        };
      }
      if (b.llmPathDegraded === true) {
        return { status: "fail", detail: "SILENT FALLBACK: ok:true but llmPathDegraded=true" };
      }
      const briefs = Array.isArray(b.briefs) ? b.briefs : b.brief ? [b.brief] : [];
      const llmBriefs = briefs.filter((x) => x?.source === "llm" && (x?.outputTokens ?? 0) > 0);
      if (llmBriefs.length === 0) {
        return {
          status: "warn",
          detail: "ok:true but no brief had source=llm with output tokens — legitimate no-data fallback or env can't run the LLM (inconclusive)",
        };
      }
      return {
        status: "pass",
        detail: `${llmBriefs.length}/${briefs.length} briefs from LLM (${llmBriefs.map((x) => x.market).join(",")})`,
      };
    },
  },
];

async function runCheck(check) {
  const url = `${baseUrl}${check.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = { authorization: `Bearer ${cronSecret}` };
    // Vercel preview deploys are usually behind Deployment Protection; the
    // bypass secret lets CI reach the app instead of Vercel's auth wall.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";

    if (res.status === 401) {
      // Two layers can 401: (a) Vercel Deployment Protection's edge auth wall
      // (HTML "Authentication Required" + _vercel_sso_nonce) when the bypass
      // secret is missing/stale; (b) the route's own requireCron rejecting
      // CRON_SECRET (JSON). Either way we never validated the LLM path, so both
      // WARN — neither is the silent fallback this guards against.
      const isProtectionWall = contentType.includes("text/html")
        || /_vercel_sso_nonce|Authentication Required/i.test(text);
      return {
        status: "warn",
        detail: isProtectionWall
          ? "HTTP 401 from Vercel Deployment Protection — could not bypass to reach the app; LLM path NOT validated here (set VERCEL_AUTOMATION_BYPASS_SECRET)."
          : "HTTP 401 — route rejected CRON_SECRET; could not validate the LLM path here (ensure CRON_SECRET matches this env).",
      };
    }

    if (!res.ok) {
      // Any other non-2xx is a LOUD failure (already visible in logs/monitoring)
      // — not the silent ok:true lie this guards. Inconclusive here → WARN.
      return {
        status: "warn",
        detail: `HTTP ${res.status} — cron returned a loud error; LLM path not validated here: ${text.slice(0, 160)}`,
      };
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: "warn", detail: `HTTP ${res.status} — non-JSON response, could not validate here: ${text.slice(0, 160)}` };
    }
    return check.assert(body);
  } catch (err) {
    const msg = err?.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : err?.message ?? String(err);
    return { status: "warn", detail: `request failed (transport) — could not validate here: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const check of CHECKS) {
  const r = await runCheck(check);
  results.push({ name: check.name, ...r });
  const icon = r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${icon}] ${check.name}: ${r.detail}`);
}

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");

if (failed.length > 0) {
  console.error(
    `\nai-cron smoke check FAILED for ${failed.length} cron(s): ${failed.map((r) => r.name).join(", ")}. ` +
      "A cron returned ok:true while the LLM silently did not run (the Incident-2 signature) — " +
      "see docs/external-api-failure-modes.md.",
  );
  process.exit(1);
}

console.log(
  warned.length > 0
    ? `\nai-cron smoke check passed with ${warned.length} inconclusive warn(s) — no silent LLM fallback detected ` +
        "(warns mean the LLM path could not be validated here, e.g. no AI creds in this env)."
    : "\nai-cron smoke check passed — all LLM crons demonstrably exercised the model.",
);
process.exit(0);

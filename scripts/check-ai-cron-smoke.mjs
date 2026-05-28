// scripts/check-ai-cron-smoke.mjs
//
// Deploy-time guard against the silent-fallback failure class documented in
// docs/external-api-failure-modes.md (Incident 2: a Gemini deprecation made
// 498/498 card profiles silently fall back while the cron still returned
// ok:true). The catch-block fixes now flip ok:false / HTTP 500 on full
// degradation; this check exercises each LLM cron with a MINIMAL batch and
// asserts the LLM path ACTUALLY ran, so a provider outage fails the check
// (red) instead of passing green.
//
// It needs (a) a running server that holds live AI provider creds and (b) the
// cron secret to authenticate — so it is deliberately NOT part of `next build`
// / check:security:static (those have neither a server nor AI creds). Run it
// against a preview or local server:
//
//   SMOKE_BASE_URL=https://<preview>.vercel.app CRON_SECRET=*** \
//     node scripts/check-ai-cron-smoke.mjs
//
// When SMOKE_BASE_URL or CRON_SECRET is unset it SKIPS (exit 0) so it is a
// no-op anywhere it can't run. Cost: ~$0.001 (one card profile + EN/JP briefs).
// Note: this is NOT a dry run — it performs the crons' real (tiny) work.

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
//   fail → the LLM path is degraded (the Incident-2 shape)        → exit 1
//   warn → couldn't exercise the LLM (e.g. no candidates / no data) → loud, exit 0
//   pass → the LLM demonstrably produced output
const CHECKS = [
  {
    name: "refresh-card-profiles",
    // refresh mode re-generates the stalest existing profile, so a 1-card
    // batch reliably has a candidate to drive the model.
    path: "/api/cron/refresh-card-profiles?mode=refresh&maxCards=1",
    assert: (b) => {
      if (b.ok !== true || b.llmPathDegraded === true) {
        return {
          status: "fail",
          detail:
            `ok=${b.ok} llmPathDegraded=${b.llmPathDegraded} processed=${b.totalProcessed} ` +
            `llmGenerated=${b.llmGenerated} firstError=${b.firstError ?? "null"} ` +
            `halted=${b.haltedForLlmProviderFailure}`,
        };
      }
      if ((b.totalProcessed ?? 0) === 0) {
        return { status: "warn", detail: "totalProcessed=0 — no candidate to exercise the LLM (inconclusive)" };
      }
      if ((b.llmGenerated ?? 0) < 1) {
        return { status: "fail", detail: `llmGenerated=${b.llmGenerated} with processed=${b.totalProcessed}` };
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
      if (b.ok !== true || b.llmPathDegraded === true) {
        return {
          status: "fail",
          detail: `ok=${b.ok} llmPathDegraded=${b.llmPathDegraded} llmFailureReason=${b.llmFailureReason ?? "null"}`,
        };
      }
      const briefs = Array.isArray(b.briefs) ? b.briefs : b.brief ? [b.brief] : [];
      const llmBriefs = briefs.filter((x) => x?.source === "llm" && (x?.outputTokens ?? 0) > 0);
      if (llmBriefs.length === 0) {
        return {
          status: "warn",
          detail: "no brief had source=llm with output tokens — likely the legitimate no-data fallback (inconclusive)",
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
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 401) {
      return { status: "fail", detail: "HTTP 401 — CRON_SECRET rejected" };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: "fail", detail: `HTTP ${res.status} — non-JSON response: ${text.slice(0, 200)}` };
    }
    return check.assert(body);
  } catch (err) {
    const msg = err?.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : err?.message ?? String(err);
    return { status: "fail", detail: `request failed: ${msg}` };
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
      "An LLM path is degraded — see docs/external-api-failure-modes.md.",
  );
  process.exit(1);
}

console.log(
  warned.length > 0
    ? `\nai-cron smoke check passed with ${warned.length} inconclusive warn(s) — no LLM degradation detected.`
    : "\nai-cron smoke check passed — all LLM crons exercised the model.",
);
process.exit(0);

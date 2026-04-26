# External API failure modes — silent fallback playbook

> **The rule, in one sentence:** any blanket `try { ... } catch { return fallback }` around an external API call (LLM, RPC, HTTP, queue, third-party SDK) MUST log the actual error AND propagate at least a class-level fingerprint into whatever response or telemetry the caller observes — a 100 % degradation rate must NEVER be observable as `ok: true`.

This playbook exists because we have hit the same anti-pattern twice in eight days, both times with multi-day silent windows. It is not a hypothetical — both incidents looked identical to a healthy run from outside the failure boundary.

---

## Why this keeps happening

Fallbacks are a sound idea. A flaky upstream shouldn't take out a batch; a parser miss on one card shouldn't fail 499 others. The bug is not that we have fallbacks — it's that **fallbacks designed for occasional degradation are also the path the code takes when the upstream is 100 % broken**, and we built no signal to distinguish "1 % of cards fell back today" from "100 % of cards fell back today and the LLM is dead."

The seductive thing about a blind `catch` is that it makes the cron return `200 OK`. A monitoring system that pings the cron's URL gets a green check while users see stale data. The structural cost is that a real outage looks identical to a quiet day.

---

## Incident 1 — RPC silent fallback (2026-04-07 → 2026-04-16, 9 days)

**Symptom:** users reported stale prices; Supabase CPU saturated under unrelated load.

**Visible bug** (the obvious one): `LIKE-OR` queries on `price_history_points` were the loud cause of CPU saturation and got fixed first. They were a tertiary cleanup path, not the bug actually hurting users.

**Actual root cause:** `refresh_card_metrics_for_variants` was silently erroring with `non-integer constant in DISTINCT ON` since 2026-04-07. The drain code in `lib/backfill/provider-pipeline-rollups.ts` had a too-narrow fallback: it triggered the full-sweep `refresh_card_metrics()` only when the error message contained "function does not exist" OR "could not find the function". Any other error got stored in a local `cardMetricsError` and the loop continued. The 12-hour `refresh-card-metrics` cron was the only thing advancing `public_card_metrics.market_price_as_of`, so freshness lagged on a 12 h cadence instead of failing visibly.

**Fingerprint we missed:** `pg_stat_statements` showed **0 calls** on `refresh_card_metrics_for_variants` while sibling RPCs showed thousands. Postgres rejecting an RPC at parse time aborts before the call counter increments — so a parse error makes a heavily-called RPC look like dead code from telemetry.

**Lesson distilled:** narrow error-string matching in fallback logic converts loud failures into silent data staleness. Combined with a periodic backstop, the symptom presents as "freshness slightly stale" rather than "feature broken" — and nobody opens a ticket for that.

**Reference:** `docs/ingestion-pipeline-playbook.md` Incident #14.

---

## Incident 2 — Gemini deprecation silent fallback (2026-04-25 → 2026-04-26, ~24 hours)

Caught quickly because the operator (you) ran the cron manually and noticed the response shape was off. If the cron had run only on its scheduled cadence and nobody had read the response, this would have looked exactly like Incident 1 — multi-day silent window.

**Symptom:** the operator ran `GET /api/cron/refresh-card-profiles?mode=refresh` and got:

```json
{
  "ok": true,
  "totalProcessed": 498,
  "llmGenerated": 0,
  "fallbacksUsed": 498,
  "totalInputTokens": 0,
  "totalOutputTokens": 0,
  "errors": 0,
  "firstError": null
}
```

A trained eye spots **498 fallbacks with zero LLM tokens and zero errors** as anomalous. A monitoring system that checks `body.ok === true` does not.

**Root cause:** Google retired `gemini-2.0-flash` and `gemini-1.5-flash` for new users around 2026-04-24, returning `AI_APICallError: This model models/gemini-2.0-flash is no longer available to new users` synchronously on every call. `lib/ai/card-profile-summary.ts` had:

```ts
try {
  const result = await generateText({ /* ... */ });
  // parse + return llm result
} catch {
  return buildFallbackProfile(input);   // ← swallows everything
}
```

…and the cron route counted `source === "fallback"` as part of the success path with no failure-reason propagation.

**Fingerprint we missed at the network boundary:** 70 s wall time for 498 calls = **140 ms per card**. A real Gemini call to `gemini-2.0-flash` at concurrency 5 would take 400-800 ms per call. Sub-200 ms means "threw before the network request" — almost always auth, model-not-found, or local SDK validation. We never measured this until after the fix because we had no place that surfaced per-call latency.

**Fix landed in three commits:**

| Commit | Change |
|---|---|
| `e3f2549` | Narrow the catch to log error name + message; attach `failureReason` to `CardProfileResult`; cron route now returns `llmFailureSample`, `llmFailureBuckets`, and `llmPathDegraded`; full-degradation runs return `ok: false` and HTTP 500 |
| `ed9219a` | Migrate Ace/Trainer tiers off retired models — `gemini-2.0-flash → gemini-2.5-flash`, `gemini-1.5-flash → gemini-2.5-flash-lite` |
| `564ce8c` | Raise card-profile timeout 6s → 15s for 2.5-flash latency |

**The fix that mattered structurally is `e3f2549`** — without it we'd have made the same mistake the next time Google deprecates a model. The model migration and timeout raise are reactive; the logging change is preventative.

---

## The generalized rule

> Any blanket try/catch around an external API call MUST satisfy three properties:
>
> 1. **The error is logged with its actual content** — at minimum `error.name` and `error.message`. Not `console.error("LLM failed")`. The actual error.
> 2. **The failure produces a class-level fingerprint** that propagates back to the caller — error name, count by class, sample message — in whatever response object or telemetry the caller observes.
> 3. **A 100 % degradation rate is observable as `ok: false`** at the cron / route response layer. If `processed > 0 && llm_count === 0`, that is not "ok."

If your handler returns `{ ok: true }` while every single call is taking the fallback path, your handler is lying. That is the failure mode this playbook exists to eliminate.

### Why all three matter, separately

- **(1) without (2)**: error is in Vercel logs, but the cron response says everything is fine. Nobody reads Vercel logs proactively. They read cron responses when something looks wrong — and the response says "fine."
- **(2) without (1)**: caller knows *something* failed, but the message has been homogenized to a category. When the bug is novel (a deprecation we've never seen before), category alone won't tell you what to fix. You need the literal `[GoogleGenerativeAI Error]: This model is no longer available` string to diagnose in seconds rather than hours.
- **(1) and (2) without (3)**: monitoring systems that check `body.ok === true` continue to miss full outages. The `ok` flag is the integration point with everything outside this codebase. It must be honest.

---

## Review checklist — before approving any try/catch around an external API call

Use this when reviewing code that wraps `generateText`, `supabase.rpc`, `fetch`, queue clients, or any third-party SDK call:

- [ ] **Is the catch logging the actual error?** Look for `console.error(...)` or equivalent that includes either the full error or at least `err.name` + `err.message`. A bare `catch { return fallback }` with no log is **always** a regression.
- [ ] **Does the catch attach failure metadata to the returned value?** A `failureReason` field, an error class on a result type, or a separate failure path the caller can branch on.
- [ ] **Does the caller (route / cron / action) include that metadata in the response?** Look at the immediate caller. If it returns `{ ok: true, data: result }` regardless of whether `result` is a real value or a fallback, the chain is broken.
- [ ] **Is `ok: true` impossible when 100 % of calls degraded?** Something like `const ok = !infraThrew && !(processed > 0 && successCount === 0)`. The intent: a fully degraded run is HTTP 500, not HTTP 200.
- [ ] **Is the fallback path counted distinctly from the success path in any aggregate metric** (Posthog, Sentry, custom telemetry)? Same number for both paths means you can't see the degradation without already suspecting it.
- [ ] **Is the timeout calibrated against observed p95 latency, not vibes?** A 6 s timeout against a model that p95s at 5 s will silently abort 5 % of calls forever. We hit this in Incident 2.
- [ ] **Is the error-string matching narrow?** Anti-pattern: `if (err.message.includes("function does not exist"))`. Strings drift across SDK versions, error classes are stable. Match `instanceof` or `err.code` when possible.

---

## Diagnostic moves

When you suspect a silent fallback:

1. **Check the success-path metrics for an anomaly that's not labeled an error.** Token counts of zero on an LLM cron, RPC call counts of zero in `pg_stat_statements`, queue depth that doesn't drain on its expected cadence. Those are the fingerprints that survive a swallowed exception.
2. **Compute per-call latency.** If an external call's median is 5-10x faster than expected, the call probably isn't actually happening. Sub-network-RTT means "synchronous throw before request."
3. **Look for backstop crons.** If a metric's freshness lag matches a cron's cadence exactly (12 h, 24 h, 1 h), the primary updater is broken and the backstop is the only thing carrying the metric. That's a tell-tale Incident-1 shape.
4. **`pg_stat_statements` for "0 calls" on RPCs you know are called.** Postgres parse errors abort before the call counter increments. A heavily-called RPC showing 0 calls = parse error.
5. **For LLM call sites**, the equivalent is the `*_token` columns in any AI-output table being zero on rows where `source = "llm"`. That should be impossible — LLM-sourced rows must have token counts.

---

## Inventory — current LLM call sites

As of 2026-04-26, after the Incident 2 fix landed:

### Fixed
- **`lib/ai/card-profile-summary.ts`** — uses the patched pattern (logged + propagated `failureReason`). Reference implementation for new LLM call sites.

### Still vulnerable — needs the same treatment

- **`lib/personalization/explanation/llm.ts`** *(highest priority)* — line 223:
  ```ts
  } catch {
    return buildTemplateExplanation(card, features, profile);
  }
  ```
  Fully blind catch. No log, no fingerprint, no caller-visible failure signal. Same exact shape as the pre-fix card-profile code. Also has the same `LLM_TIMEOUT_MS = 6_000` we already learned is too tight for `gemini-2.5-flash`. The `SOURCE_VERSION` constant still references "llm-gemini2-flash" in its label even though `models.ts` now resolves to 2.5 — cosmetic but should be updated when this gets touched.

- **`lib/ai/homepage-brief.ts`** *(partial)* — line 378-381:
  ```ts
  } catch (err) {
    const reason = err instanceof Error ? err.name || err.message : "unknown";
    logger.warn("[homepage-brief] LLM call failed, using fallback", { reason });
    return buildFallbackHomepageBrief(ctx, data.as_of);
  }
  ```
  Logs the reason (good), but never propagates it through `HomepageBrief` to the caller. The refresh-ai-brief cron can't see it in its API response — only Vercel logs would catch it. Same issue with the parse-miss path at line 348. Also: `HOMEPAGE_BRIEF_TIMEOUT_MS = 8_000` is marginal for 2.5-flash.

### Not vulnerable — synchronous server actions
- **`app/actions/analyze.ts`** — no try/catch, errors propagate to the client. Fine for user-triggered actions; the user retries.
- **`actions/generate-summary.ts`** — same.

---

## Follow-up work

1. **Apply the `e3f2549` pattern to `lib/personalization/explanation/llm.ts`**. Add a `failureReason?: string` field to `PersonalizedExplanation` (or wrap the return in a `Result` type), log error name + message in the catch, and have the consuming code path surface degradation in whatever response it's part of.
2. **Apply the same pattern to `lib/ai/homepage-brief.ts`**. Add `failureReason?: string` to `HomepageBrief`, propagate it through to the cron's API response. Bump `HOMEPAGE_BRIEF_TIMEOUT_MS` to 15 s for parity with card-profile.
3. **Add a smoke check to CI/preview** that hits each AI cron with `?maxCards=1` and asserts `llmGenerated > 0`. Costs ~$0.001 per CI run, would have caught Incident 2 within the deploy that broke it.
4. **Generalize the "100 % degradation = ok:false" rule into a small shared helper.** Something like `isLlmPathDegraded({ processed, llmCount })` so each cron route doesn't reinvent the predicate. Optional — consistency over reach.

---

## Related memory notes

- [`project_silent_rpc_fallbacks.md`](../../.claude/projects/-Users-popalpha-Documents-PopAlpha/memory/project_silent_rpc_fallbacks.md) — Incident 1 in compact form, with the `pg_stat_statements` diagnostic.
- [`pref_systemic_fixes.md`](../../.claude/projects/-Users-popalpha-Documents-PopAlpha/memory/pref_systemic_fixes.md) — operator preference for root-cause fixes over symptom patches; this playbook is the codified version of that for the silent-fallback class.

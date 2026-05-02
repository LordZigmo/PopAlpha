import { NextResponse } from "next/server";

import { generateHomepageBrief } from "@/lib/ai/homepage-brief";
import { requireCron } from "@/lib/auth/require";
import { getHomepageData } from "@/lib/data/homepage";
import { dbAdmin } from "@/lib/db/admin";

/**
 * Cron: regenerate the cached homepage AI Brief.
 *
 * Schedule (registered in vercel.json): hourly at :23 to avoid clashing
 * with the other homepage crons that fire on :00 and :30.
 *
 * Flow:
 *   1. Load the same HomepageData the public /api/homepage route serves.
 *   2. Ask Gemini for a structured brief (summary + takeaway + focusSet).
 *      If the LLM fails or returns malformed output, a deterministic
 *      fallback is used so the cache is never empty.
 *   3. Insert the new row into public.ai_brief_cache.
 *   4. Prune rows older than 7 days to keep the table small.
 *
 * Reads go through public.public_ai_brief_latest (the single most recent
 * row), so iOS and web always see the newest brief without knowing about
 * the retention window.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const PRUNE_BEFORE_DAYS = 7;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const startMs = Date.now();

  try {
    const data = await getHomepageData();
    const brief = await generateHomepageBrief(data);

    const supabase = dbAdmin();

    const { error: insertError } = await supabase
      .from("ai_brief_cache")
      .insert({
        version: brief.version,
        summary: brief.summary,
        takeaway: brief.takeaway,
        whats_happening: brief.whatsHappening,
        why_it_matters:  brief.whyItMatters,
        what_to_watch:   brief.whatToWatch,
        focus_set: brief.focusSet,
        model_label: brief.modelLabel,
        input_tokens: brief.inputTokens,
        output_tokens: brief.outputTokens,
        duration_ms: brief.durationMs,
        source: brief.source,
        data_as_of: brief.dataAsOf,
      });

    if (insertError) {
      console.error("[cron/refresh-ai-brief] insert failed:", insertError.message);
      return NextResponse.json(
        { ok: false, error: insertError.message },
        { status: 500 },
      );
    }

    // Prune old rows. Non-fatal if it fails — the insert already succeeded
    // and the public view only reads the newest row.
    const pruneCutoff = new Date(Date.now() - PRUNE_BEFORE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: pruneError } = await supabase
      .from("ai_brief_cache")
      .delete()
      .lt("generated_at", pruneCutoff);
    if (pruneError) {
      console.warn("[cron/refresh-ai-brief] prune failed:", pruneError.message);
    }

    // Degradation predicate: source !== "llm" AND we attempted the LLM
    // (failureReason is set). The two-step distinguishes the legitimate
    // short-circuit path (no mover data → fallback with no failureReason
    // → ok:true, healthy run) from a real degradation (LLM threw or
    // returned junk → fallback with failureReason → ok:false so this
    // can't silently look like a successful cron). See
    // docs/external-api-failure-modes.md for the rule.
    const llmPathDegraded =
      brief.source !== "llm" && typeof brief.failureReason === "string";

    return NextResponse.json(
      {
        ok: !llmPathDegraded,
        durationMs: Date.now() - startMs,
        llmPathDegraded,
        // Populated only on a degraded run.
        llmFailureReason: brief.failureReason ?? null,
        brief: {
          source: brief.source,
          summary: brief.summary,
          takeaway: brief.takeaway,
          whatsHappening: brief.whatsHappening,
          whyItMatters:   brief.whyItMatters,
          whatToWatch:    brief.whatToWatch,
          focusSet: brief.focusSet,
          modelLabel: brief.modelLabel,
          inputTokens: brief.inputTokens,
          outputTokens: brief.outputTokens,
          generationMs: brief.durationMs,
        },
      },
      { status: llmPathDegraded ? 500 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/refresh-ai-brief] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

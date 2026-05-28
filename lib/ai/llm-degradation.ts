// Shared predicate for the silent-fallback failure class documented in
// docs/external-api-failure-modes.md. A cron that processed work but produced
// ZERO real LLM output is degraded — every call fell back — and that MUST
// surface as ok:false, never a green ok:true. A run that processed nothing is
// NOT degraded (legitimate "no work to do").
//
// This is the count-based shape used by batch crons (e.g. refresh-card-profiles).
// Item-level degradation (e.g. refresh-ai-brief, which marks a brief degraded
// when its source !== "llm" AND it carries a failureReason) is a distinct
// signal and intentionally not folded in here.
export function isLlmPathDegraded({
  processed,
  llmCount,
}: {
  processed: number;
  llmCount: number;
}): boolean {
  return processed > 0 && llmCount === 0;
}

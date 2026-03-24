import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { getProviderCooldownState } from "@/lib/backfill/provider-cooldown";
import { SCRYDEX_2024_PLUS_PROVIDER_SET_IDS } from "@/lib/backfill/scrydex-2024plus-targets";
import {
  backfillScrydexPriceHistoryForSet,
  buildScrydexRecentHistoryCatchupPlan,
  loadScrydexRecentHistoryCoverageAudits,
} from "@/lib/backfill/scrydex-price-history";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_CATCHUP_DAYS = process.env.SCRYDEX_2024PLUS_CATCHUP_DAYS
  ? Math.max(1, parseInt(process.env.SCRYDEX_2024PLUS_CATCHUP_DAYS, 10))
  : 90;
// Keep each catch-up run under the cron runtime ceiling while burning down the backlog faster.
const DEFAULT_CATCHUP_MAX_CREDITS = process.env.SCRYDEX_2024PLUS_CATCHUP_MAX_CREDITS
  ? Math.max(3, parseInt(process.env.SCRYDEX_2024PLUS_CATCHUP_MAX_CREDITS, 10))
  : 600;

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const days = Math.max(1, parseOptionalInt(url.searchParams.get("days")) ?? DEFAULT_CATCHUP_DAYS);
    const maxCredits = Math.max(3, parseOptionalInt(url.searchParams.get("maxCredits")) ?? DEFAULT_CATCHUP_MAX_CREDITS);
    const dryRun = url.searchParams.get("dryRun") === "1";
    const force = url.searchParams.get("force") === "1";

    const providerCooldown = await getProviderCooldownState("SCRYDEX");
    if (providerCooldown.active && !force) {
      return NextResponse.json({
        ok: true,
        mode: "blocked",
        reason: "provider_cooldown_active",
        cooldownUntil: providerCooldown.cooldownUntil,
        days,
        maxCredits,
        estimatedCredits: 0,
        plannedCards: 0,
        selectedSetCount: 0,
        runs: [],
      });
    }

    const audits = await loadScrydexRecentHistoryCoverageAudits({
      providerSetIds: [...SCRYDEX_2024_PLUS_PROVIDER_SET_IDS],
      days,
    });
    const plan = buildScrydexRecentHistoryCatchupPlan({
      audits: audits.filter((audit) => audit.cardsMissingRecentSnapshot > 0),
      maxCredits,
    });
    const setsAwaitingDailyCapture = audits
      .filter((audit) => audit.cardsMissingMappings > 0)
      .map((audit) => ({
        providerSetId: audit.providerSetId,
        setCode: audit.setCode,
        setName: audit.setName,
        expectedCardCount: audit.expectedCardCount,
        matchedCardCount: audit.matchedCardCount,
        cardsMissingMappings: audit.cardsMissingMappings,
        dailyCaptureRequests: audit.dailyCaptureRequests,
      }));

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        mode: "plan",
        days,
        maxCredits,
        estimatedCredits: plan.estimatedCredits,
        plannedCards: plan.plannedCards,
        selectedSetCount: plan.selectedSets.length,
        setsAwaitingDailyCapture,
        plan,
      });
    }

    const runs = [];
    let ok = true;

    for (const selectedSet of plan.selectedSets) {
      const history = await backfillScrydexPriceHistoryForSet({
        providerSetId: selectedSet.providerSetId,
        days,
        maxCards: selectedSet.plannedCardCount,
        onlyMissingRecentHistory: true,
      });
      ok = ok && history.ok;
      runs.push({
        providerSetId: selectedSet.providerSetId,
        setCode: selectedSet.setCode,
        setName: selectedSet.setName,
        expectedCardCount: selectedSet.expectedCardCount,
        matchedCardCount: selectedSet.matchedCardCount,
        cardsWithRecentSnapshot: selectedSet.cardsWithRecentSnapshot,
        cardsMissingRecentSnapshot: selectedSet.cardsMissingRecentSnapshot,
        plannedCardCount: selectedSet.plannedCardCount,
        plannedCredits: selectedSet.plannedCredits,
        history,
      });
    }

    return NextResponse.json({
      ok,
      mode: "execute",
      days,
      maxCredits,
      estimatedCredits: plan.estimatedCredits,
      plannedCards: plan.plannedCards,
      selectedSetCount: plan.selectedSets.length,
      setsAwaitingDailyCapture,
      plan,
      runs,
    }, { status: ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

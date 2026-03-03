"use server";

import { generateText } from "ai";
import { getAnalysisPromptForTier } from "@/lib/ai/prompts";
import { getPopAlphaModel, type PopAlphaTier } from "@/lib/ai/models";

export type CardAnalysisInput = {
  tier: PopAlphaTier;
  card: {
    name: string;
    setName?: string | null;
    marketPrice?: number | null;
    change24hPct?: number | null;
    change7dPct?: number | null;
    grade10Price?: number | null;
    rawPrice?: number | null;
    viewCount24h?: number | null;
    previousViewCount24h?: number | null;
    communityVotesBullish?: number | null;
    communityVotesBearish?: number | null;
    notes?: string | null;
  };
};

export type CardAnalysisResult = {
  tier: PopAlphaTier;
  persona: string;
  text: string;
};

function toCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function toPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function calculateGradingGap(grade10Price: number | null | undefined, rawPrice: number | null | undefined) {
  if (
    typeof grade10Price !== "number"
    || !Number.isFinite(grade10Price)
    || typeof rawPrice !== "number"
    || !Number.isFinite(rawPrice)
    || rawPrice <= 0
  ) {
    return null;
  }

  const spread = grade10Price - rawPrice;
  const ratioPct = (spread / rawPrice) * 100;

  return {
    spread,
    ratioPct,
  };
}

function calculateViewGrowth(
  currentViews: number | null | undefined,
  previousViews: number | null | undefined,
): number | null {
  if (
    typeof currentViews !== "number"
    || !Number.isFinite(currentViews)
    || typeof previousViews !== "number"
    || !Number.isFinite(previousViews)
    || previousViews <= 0
  ) {
    return null;
  }

  return ((currentViews - previousViews) / previousViews) * 100;
}

export async function generateCardAnalysis(
  input: CardAnalysisInput,
): Promise<CardAnalysisResult> {
  const { tier, card } = input;
  const prompt = getAnalysisPromptForTier(tier);
  const gradingGap = calculateGradingGap(card.grade10Price, card.rawPrice);
  const viewGrowthPct = calculateViewGrowth(card.viewCount24h, card.previousViewCount24h);

  const dynamicContext = [
    `Card: ${card.name}`,
    `Set: ${card.setName ?? "Unknown set"}`,
    `Market price: ${toCurrency(card.marketPrice)}`,
    `24H change: ${toPercent(card.change24hPct)}`,
    `7D change: ${toPercent(card.change7dPct)}`,
    `RAW price: ${toCurrency(card.rawPrice)}`,
    `PSA 10 price: ${toCurrency(card.grade10Price)}`,
    gradingGap
      ? `Grading gap spread: ${toCurrency(gradingGap.spread)} (${gradingGap.ratioPct.toFixed(2)}%)`
      : "Grading gap: unavailable",
    typeof card.viewCount24h === "number" && Number.isFinite(card.viewCount24h)
      ? `Views (24H): ${Math.round(card.viewCount24h)}`
      : "Views (24H): unavailable",
    viewGrowthPct !== null
      ? `View growth: ${viewGrowthPct.toFixed(2)}%`
      : "View growth: unavailable",
    typeof card.communityVotesBullish === "number" && Number.isFinite(card.communityVotesBullish)
      ? `Bullish votes: ${Math.round(card.communityVotesBullish)}`
      : "Bullish votes: unavailable",
    typeof card.communityVotesBearish === "number" && Number.isFinite(card.communityVotesBearish)
      ? `Bearish votes: ${Math.round(card.communityVotesBearish)}`
      : "Bearish votes: unavailable",
    card.notes ? `Additional notes: ${card.notes}` : "Additional notes: none",
  ].join("\n");

  const tierInstructions =
    tier === "Elite"
      ? "For Elite, explicitly analyze Velocity of Hype from the view data, and end with exactly one Investment Grade: Strong Buy, Accumulate, or Trim. If view growth exceeds 50%, prefix the response with 'WHALE ALERT:'."
      : tier === "Ace"
        ? "For Ace, explicitly discuss Supply Squeeze, whether the card is Mooning or cooling, and whether the Grading Gap makes it a Steal."
        : "For Trainer, keep it to 2-4 sentences, very punchy, and easy for a casual collector to understand.";

  const { text } = await generateText({
    model: getPopAlphaModel(tier),
    system: prompt.system,
    prompt: [
      `Persona: ${prompt.persona}`,
      `Tone: ${prompt.tone}`,
      tierInstructions,
      "Use only the supplied metrics. If a metric is unavailable, say that the data is thin instead of inventing it.",
      "",
      dynamicContext,
    ].join("\n"),
  });

  return {
    tier,
    persona: prompt.persona,
    text,
  };
}

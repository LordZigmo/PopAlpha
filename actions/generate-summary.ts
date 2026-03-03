"use server";

import { generateText } from "ai";
import { getPopAlphaModel, type PopAlphaTier } from "@/lib/ai/models";

type CardSummaryInput = {
  cardName: string;
  setName: string | null;
  median7d: number | null;
  median30d: number | null;
  change7dPct: number | null;
  low30d: number | null;
  high30d: number | null;
  populationTotal: number | null;
  populationHigherPct: number | null;
};

export async function generateCardSummary(
  input: CardSummaryInput,
  tier: PopAlphaTier = "Trainer",
): Promise<string> {
  const model = getPopAlphaModel(tier);

  const priceLines = [
    input.median7d != null ? `7-day median price: $${input.median7d.toFixed(2)}` : null,
    input.median30d != null ? `30-day median price: $${input.median30d.toFixed(2)}` : null,
    input.change7dPct != null ? `7-day price change: ${input.change7dPct > 0 ? "+" : ""}${input.change7dPct.toFixed(1)}%` : null,
    input.low30d != null && input.high30d != null ? `30-day range: $${input.low30d.toFixed(2)} – $${input.high30d.toFixed(2)}` : null,
  ].filter(Boolean);

  const popLines = [
    input.populationTotal != null ? `Total graded population: ${input.populationTotal.toLocaleString()}` : null,
    input.populationHigherPct != null ? `Percentage graded higher: ${input.populationHigherPct.toFixed(1)}%` : null,
  ].filter(Boolean);

  const dataBlock = [
    ...priceLines,
    ...(popLines.length > 0 ? ["", ...popLines] : []),
  ].join("\n");

  const { text } = await generateText({
    model,
    system:
      "You are a Pokemon TCG market analyst. Write a concise 2-3 sentence summary of the card's current market position based on the data provided. Focus on actionable insight — is it trending up or down, is it fairly priced, and how does scarcity affect value. Do not repeat raw numbers; interpret them.",
    prompt: `Card: ${input.cardName}${input.setName ? ` (${input.setName})` : ""}\n\n${dataBlock}`,
  });

  return text;
}

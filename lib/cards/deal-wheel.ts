export type DealWheelVerdict = {
  tone: "neutral" | "positive" | "negative";
  label: "Fair Deal" | "Buyer Advantage" | "Dealer Advantage";
  strength: "Balanced" | "Slight" | "Strong" | "Very Strong";
  difference: number;
  differencePercent: number;
  explanation: string;
};

function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0));
}

export function getDealWheelStep(balancePrice: number): number {
  if (!Number.isFinite(balancePrice) || balancePrice <= 0) return 1;
  if (balancePrice < 1) return 0.01;
  if (balancePrice < 5) return 0.05;
  if (balancePrice < 20) return 0.25;
  if (balancePrice < 75) return 0.5;
  if (balancePrice < 200) return 1;
  if (balancePrice < 500) return 2.5;
  if (balancePrice < 1000) return 5;
  return 10;
}

export function getDealWheelBounds(balancePrice: number): { min: number; max: number } {
  const step = getDealWheelStep(balancePrice);
  const span = Math.max(balancePrice * 0.45, step * 10);
  const rawMin = Math.max(0, balancePrice - span);
  const rawMax = balancePrice + span;

  const min = Math.max(0, roundToStep(rawMin, step));
  const max = Math.max(min + step, roundToStep(rawMax, step));

  return { min, max };
}

export function normalizeDealWheelPrice(value: number, balancePrice: number): number {
  const step = getDealWheelStep(balancePrice);
  const { min, max } = getDealWheelBounds(balancePrice);
  const safeValue = Number.isFinite(value) ? value : balancePrice;
  const clamped = Math.min(max, Math.max(min, safeValue));
  return roundToStep(clamped, step);
}

export function evaluateDealWheelPrice(selectedPrice: number, balancePrice: number): DealWheelVerdict {
  const difference = selectedPrice - balancePrice;
  const differencePercent = balancePrice > 0 ? (difference / balancePrice) * 100 : 0;
  const absolutePercent = Math.abs(differencePercent);

  if (absolutePercent <= 4) {
    return {
      tone: "neutral",
      label: "Fair Deal",
      strength: "Balanced",
      difference,
      differencePercent,
      explanation: "This sits close to current market balance, so neither side has a clear edge.",
    };
  }

  const strength: DealWheelVerdict["strength"] =
    absolutePercent <= 10 ? "Slight" : absolutePercent <= 20 ? "Strong" : "Very Strong";
  const buyerAdvantage = difference < 0;

  return {
    tone: buyerAdvantage ? "positive" : "negative",
    label: buyerAdvantage ? "Buyer Advantage" : "Dealer Advantage",
    strength,
    difference,
    differencePercent,
    explanation: buyerAdvantage
      ? "The adjusted price is below market balance, which improves value for the buyer."
      : "The adjusted price is above market balance, which improves margin for the dealer.",
  };
}

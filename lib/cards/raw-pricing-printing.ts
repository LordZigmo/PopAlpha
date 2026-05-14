export type RawPricingPrinting = {
  id: string;
  language: string | null;
  edition: string | null;
  stamp: string | null;
  finish: string | null;
  updated_at?: string | null;
};

function languagePriority(printing: RawPricingPrinting): number {
  return String(printing.language ?? "EN").toUpperCase() === "EN" ? 0 : 1;
}

function editionPriority(printing: RawPricingPrinting): number {
  switch (String(printing.edition ?? "UNKNOWN").toUpperCase()) {
    case "UNLIMITED":
      return 0;
    case "UNKNOWN":
      return 1;
    default:
      return 2;
  }
}

function stampPriority(printing: RawPricingPrinting): number {
  return String(printing.stamp ?? "").trim() === "" ? 0 : 1;
}

function finishPriority(printing: RawPricingPrinting): number {
  switch (String(printing.finish ?? "UNKNOWN").toUpperCase()) {
    case "NON_HOLO":
      return 0;
    case "HOLO":
      return 1;
    case "REVERSE_HOLO":
      return 2;
    case "ALT_HOLO":
      return 3;
    default:
      return 4;
  }
}

function compareUpdatedAtDesc(left: RawPricingPrinting, right: RawPricingPrinting): number {
  const leftTs = Date.parse(left.updated_at ?? "");
  const rightTs = Date.parse(right.updated_at ?? "");
  const leftSafe = Number.isFinite(leftTs) ? leftTs : 0;
  const rightSafe = Number.isFinite(rightTs) ? rightTs : 0;
  return rightSafe - leftSafe;
}

export function choosePreferredRawPricingPrinting<T extends RawPricingPrinting>(printings: T[]): T | null {
  if (printings.length === 0) return null;

  return [...printings].sort((left, right) => {
    const languageDelta = languagePriority(left) - languagePriority(right);
    if (languageDelta !== 0) return languageDelta;

    const editionDelta = editionPriority(left) - editionPriority(right);
    if (editionDelta !== 0) return editionDelta;

    const stampDelta = stampPriority(left) - stampPriority(right);
    if (stampDelta !== 0) return stampDelta;

    const finishDelta = finishPriority(left) - finishPriority(right);
    if (finishDelta !== 0) return finishDelta;

    const updatedDelta = compareUpdatedAtDesc(left, right);
    if (updatedDelta !== 0) return updatedDelta;

    return left.id.localeCompare(right.id);
  })[0] ?? null;
}

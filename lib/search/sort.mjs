export const SEARCH_SORTS = ["relevance", "market-price", "newest", "oldest"];

function compareText(a, b) {
  return (a ?? "").localeCompare(b ?? "");
}

function compareYearWithUnknownLast(aYear, bYear, sort) {
  const aKnown = typeof aYear === "number";
  const bKnown = typeof bYear === "number";

  if (aKnown && !bKnown) return -1;
  if (!aKnown && bKnown) return 1;
  if (!aKnown && !bKnown) return 0;

  if (sort === "newest" && aYear !== bYear) {
    return bYear - aYear;
  }

  if (sort === "oldest" && aYear !== bYear) {
    return aYear - bYear;
  }

  return 0;
}

export function parseSearchSort(value) {
  return SEARCH_SORTS.includes(value) ? value : "relevance";
}

export function sortSearchResults(items, sort) {
  const resolvedSort = parseSearchSort(sort);
  const next = [...items];

  if (resolvedSort === "relevance") {
    return next;
  }

  if (resolvedSort === "market-price") {
    next.sort((a, b) => {
      const aPrice = typeof a.raw_price === "number" ? a.raw_price : null;
      const bPrice = typeof b.raw_price === "number" ? b.raw_price : null;

      if (aPrice !== null && bPrice === null) return -1;
      if (aPrice === null && bPrice !== null) return 1;
      if (aPrice !== null && bPrice !== null && aPrice !== bPrice) return bPrice - aPrice;

      const nameCmp = compareText(a.canonical_name, b.canonical_name);
      if (nameCmp !== 0) return nameCmp;

      const setCmp = compareText(a.set_name, b.set_name);
      if (setCmp !== 0) return setCmp;

      return compareText(a.canonical_slug, b.canonical_slug);
    });

    return next;
  }

  next.sort((a, b) => {
    const yearCmp = compareYearWithUnknownLast(a.year, b.year, resolvedSort);
    if (yearCmp !== 0) return yearCmp;

    const nameCmp = compareText(a.canonical_name, b.canonical_name);
    if (nameCmp !== 0) return nameCmp;

    const setCmp = compareText(a.set_name, b.set_name);
    if (setCmp !== 0) return setCmp;

    return compareText(a.canonical_slug, b.canonical_slug);
  });

  return next;
}

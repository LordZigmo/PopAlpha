const DEFAULT_PAGE_SIZE = 1000;

export function normalizePairingName(value) {
  return String(value ?? "").trim().toLowerCase();
}

async function loadPagedRows({
  supabase,
  table,
  select,
  pageSize = DEFAULT_PAGE_SIZE,
  configure = (query) => query,
}) {
  const rows = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const query = configure(supabase.from(table).select(select)).range(from, to);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

export async function loadCanonicalCardsForPairing(supabase) {
  return loadPagedRows({
    supabase,
    table: "canonical_cards",
    select: "slug, language, canonical_name, set_name",
    configure: (query) => query.order("slug", { ascending: true }),
  });
}

export async function loadCardPrintingsForPairing(supabase) {
  return loadPagedRows({
    supabase,
    table: "card_printings",
    select: "id, canonical_slug, set_code",
    configure: (query) => query
      .not("set_code", "is", null)
      .order("canonical_slug", { ascending: true })
      .order("set_code", { ascending: true })
      .order("id", { ascending: true }),
  });
}

export async function loadSetPairMapForPairing(supabase, { verifiedOnly = false } = {}) {
  return loadPagedRows({
    supabase,
    table: "set_pair_map",
    select: [
      "en_set_code",
      "jp_set_code",
      "en_set_name",
      "jp_set_name",
      "en_card_count",
      "jp_card_count",
      "name_match_count",
      "name_match_pct",
      "verified",
      "source",
    ].join(", "),
    configure: (query) => {
      let q = query.order("en_set_code", { ascending: true });
      if (verifiedOnly) q = q.eq("verified", true);
      return q;
    },
  });
}

export async function loadPairingCatalogInputs(supabase, { setPairs = null } = {}) {
  const [canonicalCards, cardPrintings, loadedSetPairs] = await Promise.all([
    loadCanonicalCardsForPairing(supabase),
    loadCardPrintingsForPairing(supabase),
    setPairs ? Promise.resolve(setPairs) : loadSetPairMapForPairing(supabase),
  ]);

  return {
    canonicalCards,
    cardPrintings,
    setPairs: loadedSetPairs,
  };
}

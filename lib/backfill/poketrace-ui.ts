import { dbAdmin } from "@/lib/db/admin";

type MatchRow = {
  provider_normalized_observation_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
  updated_at: string | null;
};

type NormalizedObservationRow = {
  id: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  card_name: string;
  observed_price: number | null;
  currency: string | null;
  observed_at: string;
  metadata: Record<string, unknown> | null;
};

type CanonicalCardRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
  year: number | null;
};

type PrintingRow = {
  id: string;
  image_url: string | null;
};

export type PokeTraceUiEntry = {
  providerVariantId: string;
  providerSetId: string | null;
  cardName: string;
  price: number;
  currency: string | null;
  observedAt: string;
  providerSource: string | null;
  providerTier: string | null;
  providerCondition: string | null;
  imageUrl: string | null;
};

export type PokeTraceUiCard = {
  canonicalSlug: string;
  canonicalName: string;
  setName: string | null;
  cardNumber: string | null;
  year: number | null;
  printingId: string | null;
  imageUrl: string | null;
  latestPrice: number;
  currency: string | null;
  observedAt: string;
  entries: PokeTraceUiEntry[];
};

function toStringOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractEntryImageUrl(observation: NormalizedObservationRow): string | null {
  return toStringOrNull(observation.metadata?.providerImageUrl);
}

function buildEntry(observation: NormalizedObservationRow): PokeTraceUiEntry | null {
  const price = toFiniteNumber(observation.observed_price);
  if (price === null || price <= 0) return null;

  return {
    providerVariantId: observation.provider_variant_id,
    providerSetId: observation.provider_set_id,
    cardName: observation.card_name,
    price,
    currency: toStringOrNull(observation.currency),
    observedAt: observation.observed_at,
    providerSource: toStringOrNull(observation.metadata?.providerSource),
    providerTier: toStringOrNull(observation.metadata?.providerTier),
    providerCondition: toStringOrNull(observation.metadata?.providerCondition),
    imageUrl: extractEntryImageUrl(observation),
  };
}

async function loadMatchedRows(params: {
  canonicalSlug?: string;
  printingId?: string | null;
  limit: number;
}): Promise<MatchRow[]> {
  const supabase = dbAdmin();
  let query = supabase
    .from("provider_observation_matches")
    .select("provider_normalized_observation_id, canonical_slug, printing_id, updated_at")
    .eq("provider", "POKETRACE")
    .eq("match_status", "MATCHED")
    .order("updated_at", { ascending: false })
    .limit(params.limit);

  if (params.canonicalSlug) query = query.eq("canonical_slug", params.canonicalSlug);
  if (params.printingId) query = query.eq("printing_id", params.printingId);

  const { data, error } = await query;
  if (error) throw new Error(`provider_observation_matches(poketrace): ${error.message}`);
  return (data ?? []) as MatchRow[];
}

async function loadObservations(ids: string[]): Promise<Map<string, NormalizedObservationRow>> {
  if (ids.length === 0) return new Map();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("provider_normalized_observations")
    .select("id, provider_set_id, provider_card_id, provider_variant_id, card_name, observed_price, currency, observed_at, metadata")
    .in("id", ids);

  if (error) throw new Error(`provider_normalized_observations(poketrace): ${error.message}`);

  return new Map(
    ((data ?? []) as NormalizedObservationRow[]).map((row) => [row.id, row] as const),
  );
}

async function loadCanonicalCards(slugs: string[]): Promise<Map<string, CanonicalCardRow>> {
  if (slugs.length === 0) return new Map();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, year")
    .in("slug", slugs);

  if (error) throw new Error(`canonical_cards(poketrace ui): ${error.message}`);

  return new Map(
    ((data ?? []) as CanonicalCardRow[]).map((row) => [row.slug, row] as const),
  );
}

async function loadPrintingImages(printingIds: string[]): Promise<Map<string, string | null>> {
  if (printingIds.length === 0) return new Map();

  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("card_printings")
    .select("id, image_url")
    .in("id", printingIds);

  if (error) throw new Error(`card_printings(poketrace ui): ${error.message}`);

  return new Map(
    ((data ?? []) as PrintingRow[]).map((row) => [row.id, row.image_url ?? null] as const),
  );
}

export async function loadPokeTraceCardPreview(params: {
  canonicalSlug: string;
  printingId?: string | null;
}): Promise<PokeTraceUiCard | null> {
  const matchRows = await loadMatchedRows({
    canonicalSlug: params.canonicalSlug,
    printingId: params.printingId ?? null,
    limit: 40,
  });
  if (matchRows.length === 0) return null;

  const observationById = await loadObservations(
    matchRows.map((row) => row.provider_normalized_observation_id),
  );

  const entries: PokeTraceUiEntry[] = [];
  const seenVariantIds = new Set<string>();
  let resolvedPrintingId = params.printingId ?? null;

  for (const matchRow of matchRows) {
    const observation = observationById.get(matchRow.provider_normalized_observation_id);
    if (!observation) continue;
    const entry = buildEntry(observation);
    if (!entry) continue;
    if (seenVariantIds.has(entry.providerVariantId)) continue;
    seenVariantIds.add(entry.providerVariantId);
    entries.push(entry);
    resolvedPrintingId ??= matchRow.printing_id ?? null;
    if (entries.length >= 3) break;
  }

  if (entries.length === 0) return null;

  const [canonicalBySlug, printingImages] = await Promise.all([
    loadCanonicalCards([params.canonicalSlug]),
    loadPrintingImages(resolvedPrintingId ? [resolvedPrintingId] : []),
  ]);

  const canonical = canonicalBySlug.get(params.canonicalSlug);
  if (!canonical) return null;

  const latest = entries[0];
  return {
    canonicalSlug: canonical.slug,
    canonicalName: canonical.canonical_name,
    setName: canonical.set_name,
    cardNumber: canonical.card_number,
    year: canonical.year,
    printingId: resolvedPrintingId,
    imageUrl: (resolvedPrintingId ? (printingImages.get(resolvedPrintingId) ?? null) : null) ?? latest?.imageUrl ?? null,
    latestPrice: latest.price,
    currency: latest.currency,
    observedAt: latest.observedAt,
    entries,
  };
}

export async function loadPokeTraceMobileSamples(limit = 6): Promise<PokeTraceUiCard[]> {
  const matchRows = await loadMatchedRows({ limit: Math.max(40, limit * 12) });
  if (matchRows.length === 0) return [];

  const observationById = await loadObservations(
    matchRows.map((row) => row.provider_normalized_observation_id),
  );

  const candidateCards = new Map<string, {
    canonicalSlug: string;
    printingId: string | null;
    entries: PokeTraceUiEntry[];
  }>();

  for (const matchRow of matchRows) {
    const canonicalSlug = toStringOrNull(matchRow.canonical_slug);
    if (!canonicalSlug || candidateCards.has(canonicalSlug)) continue;

    const observation = observationById.get(matchRow.provider_normalized_observation_id);
    if (!observation) continue;
    const entry = buildEntry(observation);
    if (!entry) continue;

    candidateCards.set(canonicalSlug, {
      canonicalSlug,
      printingId: matchRow.printing_id ?? null,
      entries: [entry],
    });

    if (candidateCards.size >= limit) break;
  }

  if (candidateCards.size === 0) return [];

  const slugs = [...candidateCards.keys()];
  const printingIds = [...new Set(
    [...candidateCards.values()]
      .map((row) => row.printingId)
      .filter((value): value is string => Boolean(value)),
  )];

  const [canonicalBySlug, printingImages] = await Promise.all([
    loadCanonicalCards(slugs),
    loadPrintingImages(printingIds),
  ]);

  const cards: PokeTraceUiCard[] = [];
  for (const candidate of candidateCards.values()) {
    const canonical = canonicalBySlug.get(candidate.canonicalSlug);
    const latest = candidate.entries[0];
    if (!canonical || !latest) continue;
    cards.push({
      canonicalSlug: canonical.slug,
      canonicalName: canonical.canonical_name,
      setName: canonical.set_name,
      cardNumber: canonical.card_number,
      year: canonical.year,
      printingId: candidate.printingId,
      imageUrl: (candidate.printingId ? (printingImages.get(candidate.printingId) ?? null) : null) ?? latest.imageUrl ?? null,
      latestPrice: latest.price,
      currency: latest.currency,
      observedAt: latest.observedAt,
      entries: candidate.entries,
    });
  }

  return cards
    .sort((left, right) => {
      const leftMs = Date.parse(left.observedAt);
      const rightMs = Date.parse(right.observedAt);
      return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
    })
    .slice(0, limit);
}

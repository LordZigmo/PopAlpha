import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { buildProviderCardMapKey } from "@/lib/backfill/provider-card-map";
import { dbAdmin } from "@/lib/db/admin";
import { buildProviderHistoryVariantRef } from "@/lib/identity/variant-ref.mjs";

type ProviderCardMapRow = {
  provider: string;
  provider_card_id: string;
  provider_variant_id: string;
  canonical_slug: string | null;
  printing_id: string | null;
};

type ObservationRow = {
  id: string;
  provider_set_id: string | null;
  provider_card_id: string;
  provider_variant_id: string;
  card_name: string;
  card_number: string | null;
  normalized_card_number: string | null;
  normalized_finish: string;
  normalized_edition: string;
  normalized_stamp: string;
  normalized_condition: string;
  normalized_language: string;
  observed_price: number | null;
  currency: string;
  observed_at: string;
  variant_ref: string;
};

type SnapshotRow = {
  provider: string;
  provider_ref: string | null;
  grade: string;
  price_value: number;
  currency: string;
  observed_at: string;
  printing_id: string | null;
};

type PrintingMetaRow = {
  id: string;
  finish: string;
  edition: string;
  stamp: string | null;
  language: string;
};

type HistoryRow = {
  ts: string;
  price: number;
  currency: string;
  source_window: string;
};

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  const printingId = url.searchParams.get("printing")?.trim() || null;
  const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get("limit") ?? "5", 10) || 5));

  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing required ?slug=" }, { status: 400 });
  }

  const supabase = dbAdmin();

  const { data: snapshotBaseRows, error: snapshotBaseError } = await supabase
    .from("price_snapshots")
    .select("provider, provider_ref, grade, price_value, currency, observed_at, printing_id")
    .eq("canonical_slug", slug)
    .eq("grade", "RAW")
    .order("observed_at", { ascending: false })
    .limit(limit * 20);
  if (snapshotBaseError) return NextResponse.json({ ok: false, error: snapshotBaseError.message }, { status: 500 });

  const snapshotBase = (snapshotBaseRows ?? []) as SnapshotRow[];

  const latestSnapshotByProvider = new Map<string, SnapshotRow>();
  for (const row of snapshotBase) {
    if (!latestSnapshotByProvider.has(row.provider)) latestSnapshotByProvider.set(row.provider, row);
  }

  const printIds = Array.from(new Set(snapshotBase.map((row) => row.printing_id).filter((v): v is string => Boolean(v))));
  const printingMetaById = new Map<string, PrintingMetaRow>();
  if (printIds.length > 0) {
    const { data: printingRows, error: printingError } = await supabase
      .from("card_printings")
      .select("id, finish, edition, stamp, language")
      .in("id", printIds);
    if (printingError) return NextResponse.json({ ok: false, error: printingError.message }, { status: 500 });
    for (const row of (printingRows ?? []) as PrintingMetaRow[]) printingMetaById.set(row.id, row);
  }

  let mappingQuery = supabase
    .from("provider_card_map")
    .select("provider, provider_card_id, provider_variant_id, canonical_slug, printing_id")
    .eq("mapping_status", "MATCHED")
    .eq("canonical_slug", slug);

  if (printingId) {
    mappingQuery = mappingQuery.eq("printing_id", printingId);
  } else {
    mappingQuery = mappingQuery.not("printing_id", "is", null);
  }

  const { data: mappingRows, error: mappingError } = await mappingQuery;
  if (mappingError) return NextResponse.json({ ok: false, error: mappingError.message }, { status: 500 });

  const mappings = (mappingRows ?? []) as ProviderCardMapRow[];
  if (mappings.length === 0) {
    return NextResponse.json({ ok: true, slug, printingId, readings: [] });
  }

  const byProvider = new Map<string, ProviderCardMapRow[]>();
  for (const row of mappings) {
    const bucket = byProvider.get(row.provider) ?? [];
    bucket.push(row);
    byProvider.set(row.provider, bucket);
  }

  const readings = [];

  for (const [provider, providerMatches] of byProvider.entries()) {
    const providerVariantIds = Array.from(new Set(providerMatches.map((row) => row.provider_variant_id)));
    const { data: observationRows, error: obsError } = await supabase
      .from("provider_normalized_observations")
      .select("id, provider_set_id, provider_card_id, provider_variant_id, card_name, card_number, normalized_card_number, normalized_finish, normalized_edition, normalized_stamp, normalized_condition, normalized_language, observed_price, currency, observed_at, variant_ref")
      .eq("provider", provider)
      .in("provider_variant_id", providerVariantIds)
      .order("observed_at", { ascending: false })
      .limit(Math.max(limit, providerVariantIds.length * limit));
    if (obsError) return NextResponse.json({ ok: false, error: obsError.message }, { status: 500 });

    const observations = (observationRows ?? []) as ObservationRow[];
    const latest = observations[0] ?? null;
    const mappingByKey = new Map(
      providerMatches.map((mapping) => [
        buildProviderCardMapKey(mapping.provider_card_id, mapping.provider_variant_id),
        mapping,
      ] as const),
    );

    let snapshots: SnapshotRow[] = [];
    if (latest) {
      const providerRef = `${provider.toLowerCase()}:${latest.provider_variant_id}`;
      const { data: snapshotRows, error: snapshotError } = await supabase
        .from("price_snapshots")
        .select("provider, provider_ref, grade, price_value, currency, observed_at, printing_id")
        .eq("provider", provider)
        .eq("provider_ref", providerRef)
        .order("observed_at", { ascending: false })
        .limit(limit);
      if (snapshotError) return NextResponse.json({ ok: false, error: snapshotError.message }, { status: 500 });
      snapshots = (snapshotRows ?? []) as SnapshotRow[];
    }

    let history: HistoryRow[] = [];
    if (latest) {
      const matched = mappingByKey.get(buildProviderCardMapKey(latest.provider_card_id, latest.provider_variant_id));
      const historyVariantRef = buildProviderHistoryVariantRef({
        printingId: matched?.printing_id ?? null,
        canonicalSlug: matched?.canonical_slug ?? slug,
        provider,
        providerVariantId: latest.provider_variant_id,
      });
      const { data: historyRows, error: historyError } = await supabase
        .from("price_history_points")
        .select("ts, price, currency, source_window")
        .eq("provider", provider)
        .eq("variant_ref", historyVariantRef)
        .order("ts", { ascending: false })
        .limit(limit);
      if (historyError) return NextResponse.json({ ok: false, error: historyError.message }, { status: 500 });
      history = (historyRows ?? []) as HistoryRow[];
    }

    readings.push({
      provider,
      latestSnapshot: latestSnapshotByProvider.get(provider) ?? null,
      printingMetaFromSnapshot: (() => {
        const latestForProvider = latestSnapshotByProvider.get(provider);
        const id = latestForProvider?.printing_id ?? null;
        return id ? (printingMetaById.get(id) ?? null) : null;
      })(),
      latestObservation: latest ? {
        observedAt: latest.observed_at,
        observedPrice: latest.observed_price,
        currency: latest.currency,
        grade: "RAW",
        providerSetId: latest.provider_set_id,
        providerCardId: latest.provider_card_id,
        providerVariantId: latest.provider_variant_id,
        cardName: latest.card_name,
        cardNumber: latest.card_number,
        normalizedCardNumber: latest.normalized_card_number,
        normalizedFinish: latest.normalized_finish,
        normalizedEdition: latest.normalized_edition,
        normalizedStamp: latest.normalized_stamp,
        normalizedCondition: latest.normalized_condition,
        normalizedLanguage: latest.normalized_language,
        variantRef: latest.variant_ref,
      } : null,
      snapshots,
      historyPoints: history,
    });
  }

  for (const [provider, latestSnapshot] of latestSnapshotByProvider.entries()) {
    if (readings.some((row) => row.provider === provider)) continue;
    const snapshots = snapshotBase.filter((row) => row.provider === provider).slice(0, limit);
    const printingMeta = latestSnapshot.printing_id ? (printingMetaById.get(latestSnapshot.printing_id) ?? null) : null;
    readings.push({
      provider,
      latestSnapshot,
      printingMetaFromSnapshot: printingMeta,
      latestObservation: null,
      snapshots,
      historyPoints: [],
      note: "No matched normalized observation found for this provider snapshot in current pipeline tables.",
    });
  }

  readings.sort((a, b) => a.provider.localeCompare(b.provider));

  return NextResponse.json({
    ok: true,
    slug,
    printingId,
    readings,
  });
}

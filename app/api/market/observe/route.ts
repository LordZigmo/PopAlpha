import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";
import { measureAsync } from "@/lib/perf";

export const runtime = "nodejs";

type ListingInput = {
  externalId?: string;
  title?: string;
  price?: { value?: string; currency?: string } | null;
  shipping?: { value?: string; currency?: string } | null;
  itemWebUrl?: string;
  condition?: string | null;
  seller?: string | null;
};

type ObserveRequest = {
  canonicalSlug?: string;
  printingId?: string | null;
  grade?: string;
  source?: "EBAY";
  listings?: ListingInput[];
};

function toNumeric(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(req: Request) {
  let payload: ObserveRequest;
  try {
    payload = (await req.json()) as ObserveRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const canonicalSlug = typeof payload.canonicalSlug === "string" ? payload.canonicalSlug.trim() : "";
  const grade = typeof payload.grade === "string" ? payload.grade.trim().toUpperCase() : "RAW";
  const source = payload.source ?? "EBAY";
  const printingId = typeof payload.printingId === "string" ? payload.printingId.trim() : null;
  if (!canonicalSlug) {
    return NextResponse.json({ ok: false, error: "Missing canonicalSlug." }, { status: 400 });
  }
  if (source !== "EBAY") {
    return NextResponse.json({ ok: false, error: "Unsupported source." }, { status: 400 });
  }

  const listings = Array.isArray(payload.listings) ? payload.listings : [];
  if (listings.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0 });
  }

  const rows = listings
    .map((listing) => {
      const externalId = typeof listing.externalId === "string" ? listing.externalId.trim() : "";
      const priceValue = toNumeric(listing.price?.value);
      const currency = listing.price?.currency?.trim().toUpperCase() || "USD";
      if (!externalId || priceValue === null || priceValue <= 0) return null;
      if (currency !== "USD") return null;
      return {
        source: "EBAY",
        external_id: externalId,
        canonical_slug: canonicalSlug,
        printing_id: printingId,
        grade,
        title: (listing.title ?? "").trim() || "Untitled listing",
        price_value: priceValue,
        currency,
        shipping_value: toNumeric(listing.shipping?.value),
        url: listing.itemWebUrl ?? null,
        condition: listing.condition ?? null,
        seller: listing.seller ?? null,
        raw: listing as unknown as Record<string, unknown>,
        observed_at: new Date().toISOString(),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0 });
  }

  const supabase = getServerSupabaseClient();
  const upsertResult = await measureAsync("market.observe.upsert", { canonicalSlug, grade, size: rows.length }, async () => {
    const { error } = await supabase.from("listing_observations").upsert(rows, {
      onConflict: "source,external_id",
    });
    return { error: error?.message ?? null };
  });

  if (upsertResult.error) {
    return NextResponse.json({ ok: false, error: upsertResult.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, upserted: rows.length });
}

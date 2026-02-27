import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type ListingInput = {
  externalId?: string;
  title?: string;
  price?: { value?: string; currency?: string } | null;
  shipping?: { value?: string; currency?: string } | null;
  condition?: string | null;
  seller?: string | null;
};

type ObserveRequest = {
  cardVariantId?: string;
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

  const cardVariantId = typeof payload.cardVariantId === "string" ? payload.cardVariantId.trim() : "";
  if (!cardVariantId) {
    return NextResponse.json({ ok: false, error: "Missing cardVariantId." }, { status: 400 });
  }
  const listings = Array.isArray(payload.listings) ? payload.listings : [];
  if (listings.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0 });
  }

  const rows = listings
    .map((listing) => {
      const externalId = typeof listing.externalId === "string" ? listing.externalId.trim() : "";
      const priceValue = toNumeric(listing.price?.value);
      const currency = listing.price?.currency?.trim() || "USD";
      if (!externalId || priceValue === null || priceValue <= 0) return null;
      return {
        source: "EBAY",
        external_id: externalId,
        card_variant_id: cardVariantId,
        title: (listing.title ?? "").trim() || "Untitled listing",
        price_value: priceValue,
        currency,
        shipping_value: toNumeric(listing.shipping?.value),
        condition: listing.condition ?? null,
        seller: listing.seller ?? null,
        observed_at: new Date().toISOString(),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, upserted: 0 });
  }

  const supabase = getServerSupabaseClient();
  const { error } = await supabase.from("listing_observations").upsert(rows, {
    onConflict: "source,external_id",
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, upserted: rows.length });
}


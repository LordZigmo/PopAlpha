import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { dbPublic } from "@/lib/db";
import { resolveDisplayedMarketPrice } from "@/lib/pricing/displayed-market-price";

// Brand assets inlined as data URLs (satori fetches remote URLs, but the
// local filesystem is faster and deploy-atomic). Same pattern as
// app/brand-image.tsx.
const mascotSvg = readFileSync(
  join(process.cwd(), "public/brand/popalpha-icon.svg"),
  "utf8",
);
const mascotDataUrl = `data:image/svg+xml;base64,${Buffer.from(mascotSvg).toString("base64")}`;
const wordmarkPng = readFileSync(join(process.cwd(), "public/brand/popalpha-modern-white.png"));
const wordmarkDataUrl = `data:image/png;base64,${wordmarkPng.toString("base64")}`;

// Per-card OpenGraph image. Replaces the previous behavior where
// generateMetadata in this route's page.tsx exposed the raw card
// image_url (a 63:88 portrait) as the og:image. Most link-preview
// renderers (iMessage in particular) expect a 1.91:1 landscape OG
// image and crop portrait images to fit, which is what produced the
// "half the card is cut off" share preview.
//
// This file uses Next.js's metadata-file convention: the presence of
// `opengraph-image.tsx` in a route segment automatically supplies the
// og:image and twitter:image, taking precedence over `images: [...]`
// in the page's generateMetadata.
//
// Layout (1200x630, the standard OG canvas):
//   ┌──────────────────────────────────────────────────────────────┐
//   │                                                              │
//   │   [Card image, 63:88, fit to ~480px tall]   <Card name>      │
//   │                                              <Set · #N>      │
//   │                                                              │
//   │                                            PopAlpha · ai     │
//   └──────────────────────────────────────────────────────────────┘

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "PopAlpha card preview";

// Use the dynamic runtime so we can hit Supabase per-request. The
// generated image is cached by upstream CDNs (iMessage, Slack, Twitter)
// based on URL, so per-card requests don't repeat hot-path.
export const runtime = "nodejs";

type CanonicalRow = {
  slug: string;
  canonical_name: string;
  set_name: string | null;
  card_number: string | null;
};

type PrintingRow = {
  id: string;
  finish: string | null;
  image_url: string | null;
  mirrored_image_url: string | null;
};

/// Pick the printing whose image we'll show. Prefers NON_HOLO →
/// HOLO → REVERSE_HOLO → ALT_HOLO order to match the card detail
/// page's default. Mirrors the simpler version of chooseDefaultPrinting
/// in page.tsx; we don't need full edition/stamp scoring here, just a
/// canonical image.
function pickPrintingForOg(printings: PrintingRow[]): PrintingRow | null {
  if (printings.length === 0) return null;
  const finishOrder = ["NON_HOLO", "HOLO", "REVERSE_HOLO", "ALT_HOLO"];
  const sorted = [...printings].sort((a, b) => {
    const ai = finishOrder.indexOf(a.finish ?? "");
    const bi = finishOrder.indexOf(b.finish ?? "");
    const aRank = ai === -1 ? finishOrder.length : ai;
    const bRank = bi === -1 ? finishOrder.length : bi;
    if (aRank !== bRank) return aRank - bRank;
    // Prefer printings that actually have an image
    if (!!a.image_url !== !!b.image_url) return a.image_url ? -1 : 1;
    return 0;
  });
  return sorted[0] ?? null;
}

export default async function CardOpenGraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let canonical: CanonicalRow | null = null;
  let printing: PrintingRow | null = null;
  let marketPrice: number | null = null;
  let marketPriceAsOf: string | null = null;

  try {
    const supabase = dbPublic();
    const [canonicalRes, printingsRes, metricsRes] = await Promise.all([
      supabase
        .from("canonical_cards")
        .select("slug, canonical_name, set_name, card_number")
        .eq("slug", slug)
        .maybeSingle<CanonicalRow>(),
      supabase
        .from("card_printings")
        .select("id, finish, image_url, mirrored_image_url")
        .eq("canonical_slug", slug)
        .returns<PrintingRow[]>(),
      supabase
        .from("public_card_metrics")
        .select("market_price, market_price_as_of")
        .eq("canonical_slug", slug)
        .eq("grade", "RAW")
        .is("printing_id", null)
        .maybeSingle<{ market_price: number | null; market_price_as_of: string | null }>(),
    ]);
    canonical = canonicalRes.data ?? null;
    printing = pickPrintingForOg(printingsRes.data ?? []);
    marketPrice = metricsRes.data?.market_price ?? null;
    marketPriceAsOf = metricsRes.data?.market_price_as_of ?? null;
  } catch {
    // Fall through to the brand fallback below — never let an OG
    // generation error 500; link previews degrade gracefully but
    // shouldn't be a hard failure for the share flow.
  }

  // Prefer mirrored Storage URL (faster, no Scrydex dependency) but
  // fall back to the original if the mirror hasn't run yet.
  const cardImageUrl = printing?.mirrored_image_url ?? printing?.image_url ?? null;
  const cardName = canonical?.canonical_name ?? "PopAlpha";
  const setLine = [canonical?.set_name, canonical?.card_number ? `#${canonical.card_number}` : null]
    .filter(Boolean)
    .join(" · ");

  // Same honest classification as the page hero: a confident dollar
  // figure only when the price is current; "last sold" labeling for
  // recent-stale; no chip at all rather than a misleading one.
  const display = resolveDisplayedMarketPrice({ marketPrice, marketPriceAsOf });
  const priceText =
    display.kind === "live" || display.kind === "abundant" || display.kind === "stale_recent"
      ? `$${display.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null;
  const priceEyebrow =
    display.kind === "stale_recent" ? `LAST SOLD · ${display.ageLabel.toUpperCase()}` : "MARKET PRICE";

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          background: "linear-gradient(135deg, #02050b 0%, #081223 42%, #02050b 100%)",
          color: "#F0F0F0",
          padding: "56px 72px",
          position: "relative",
          overflow: "hidden",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {/* Subtle radial accent, matches app/brand-image.tsx style */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 22% 18%, rgba(0,180,216,0.22), rgba(0,0,0,0) 36%), radial-gradient(circle at 80% 85%, rgba(0,180,216,0.12), rgba(0,0,0,0) 30%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 32,
            borderRadius: 36,
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        />

        {/* Two-column layout */}
        <div
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 56,
            zIndex: 1,
          }}
        >
          {/* Left: card image — 63:88 ratio, fit so the whole card is
              visible (no cropping). At 480px tall the width becomes
              ~344px which leaves plenty of room for the right column. */}
          <div
            style={{
              display: "flex",
              width: 360,
              height: 504,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 24,
              background: cardImageUrl ? "transparent" : "rgba(255,255,255,0.04)",
              border: cardImageUrl ? "none" : "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {cardImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={cardName}
                src={cardImageUrl}
                width={344}
                height={480}
                style={{
                  borderRadius: 16,
                  boxShadow: "0 24px 56px rgba(0,0,0,0.55)",
                  objectFit: "contain",
                }}
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  fontSize: 22,
                  color: "#7C8597",
                }}
              >
                No image
              </div>
            )}
          </div>

          {/* Right: card metadata */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 20,
              maxWidth: 660,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="PopAlpha"
              src={wordmarkDataUrl}
              style={{ width: 234, height: 52, objectFit: "contain", objectPosition: "left" }}
            />

            <div
              style={{
                display: "flex",
                fontSize: 64,
                lineHeight: 1.05,
                fontWeight: 800,
                letterSpacing: "-0.03em",
              }}
            >
              {cardName}
            </div>

            {setLine ? (
              <div
                style={{
                  display: "flex",
                  fontSize: 28,
                  color: "#AFB8C7",
                  lineHeight: 1.3,
                }}
              >
                {setLine}
              </div>
            ) : null}
          </div>
        </div>

        {/* Price chip — overlays the card art's lower-right edge, the
            mascot sits beside the figure (owner spec: card + price
            overlay in front + logo next to it). Rendered only when the
            price classification is confident. */}
        {priceText ? (
          <div
            style={{
              position: "absolute",
              left: 300,
              bottom: 88,
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "18px 28px",
              borderRadius: 26,
              background: "rgba(5,12,24,0.93)",
              border: "1px solid rgba(0,180,216,0.45)",
              boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src={mascotDataUrl} width={62} height={62} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div
                style={{
                  display: "flex",
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: "0.16em",
                  color: "#9EDCF2",
                }}
              >
                {priceEyebrow}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 50,
                  fontWeight: 800,
                  letterSpacing: "-0.03em",
                  color: "#FFFFFF",
                }}
              >
                {priceText}
              </div>
            </div>
          </div>
        ) : null}

        {/* Bottom-right footer */}
        <div
          style={{
            position: "absolute",
            right: 88,
            bottom: 72,
            display: "flex",
            fontSize: 18,
            fontWeight: 600,
            color: "rgba(255,255,255,0.4)",
            letterSpacing: "0.04em",
          }}
        >
          popalpha.ai
        </div>
      </div>
    ),
    { ...size },
  );
}

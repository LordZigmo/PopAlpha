import { config as loadEnv } from "dotenv";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

const setName = process.argv.slice(2).join(" ").trim() || "Ascended Heroes";
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function formatUsd(value) {
  if (value === null || !Number.isFinite(value)) return "an unpriced level";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatSignedPct(value) {
  if (value === null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}%`;
}

function buildPopAlphaScoutSummary({
  cardName,
  marketPrice,
  fairValue,
  changePct,
  changeLabel,
  activeListings7d,
}) {
  const priceText = formatUsd(marketPrice);
  const fairValueText = fairValue !== null ? formatUsd(fairValue) : null;
  const changeText = formatSignedPct(changePct);

  let openingLine = `Okay, so ${cardName} is trading around ${priceText}, which is kind of wild if you have been watching this one.`;
  if (changeText && changeLabel) {
    openingLine = changePct > 0
      ? `Okay, so ${cardName} is trading around ${priceText}, and it is up ${changeText} over the last ${changeLabel}, which is making it feel pretty lively.`
      : changePct < 0
        ? `Okay, so ${cardName} is trading around ${priceText}, after a ${changeText} move over the last ${changeLabel}, so the market cooled off a bit.`
        : `Okay, so ${cardName} is trading around ${priceText}, and it has been basically flat over the last ${changeLabel}.`;
  }

  let valueLine = "I am still waiting on enough fair-value data to really map this one out.";
  if (marketPrice !== null && fairValue !== null && fairValue > 0) {
    const edgePct = ((marketPrice - fairValue) / fairValue) * 100;
    if (edgePct <= -1) {
      valueLine = `By my notes, that is below our fair value mark near ${fairValueText}, so this might actually be a pretty nice pickup for the binder.`;
    } else if (edgePct >= 1) {
      valueLine = `By my notes, that is above our fair value mark near ${fairValueText}, so people are definitely paying extra for it right now.`;
    } else {
      valueLine = `By my notes, that is almost exactly on top of our fair value mark near ${fairValueText}, which is honestly weirdly tidy.`;
    }
  }

  let supplyLine = "Supply is still kind of fuzzy from here.";
  if (activeListings7d !== null) {
    if (activeListings7d <= 4) {
      supplyLine = `There were only ${activeListings7d} live listings over the last 7 days, so supply looks pretty tight for a chase like this.`;
    } else {
      supplyLine = `There were ${activeListings7d} live listings over the last 7 days, so there is enough on the board that you do not have to panic-buy it.`;
    }
  }

  return {
    summaryShort: openingLine,
    summaryLong: `${openingLine} ${valueLine} ${supplyLine}`,
  };
}

function formatSingleWindowLabel(change24hPct, change7dPct) {
  if (typeof change24hPct === "number" && Number.isFinite(change24hPct)) {
    return { changePct: change24hPct, changeLabel: "24h" };
  }
  if (typeof change7dPct === "number" && Number.isFinite(change7dPct)) {
    return { changePct: change7dPct, changeLabel: "7d" };
  }
  return { changePct: null, changeLabel: null };
}

const { data: cards, error: cardsError } = await supabase
  .from("canonical_cards")
  .select("slug, canonical_name")
  .eq("set_name", setName)
  .order("card_number", { ascending: true });

if (cardsError) {
  throw new Error(`Failed reading canonical_cards: ${cardsError.message}`);
}

if (!cards || cards.length === 0) {
  console.log(JSON.stringify({ ok: true, setName, found: 0, upserted: 0 }));
  process.exit(0);
}

const slugs = cards.map((card) => card.slug);
const { data: metricsRows, error: metricsError } = await supabase
  .from("public_card_metrics")
  .select("canonical_slug, market_price, change_pct_24h, change_pct_7d, active_listings_7d, median_30d, trimmed_median_30d")
  .in("canonical_slug", slugs)
  .is("printing_id", null)
  .eq("grade", "RAW");

if (metricsError) {
  throw new Error(`Failed reading public_card_metrics: ${metricsError.message}`);
}

const metricsBySlug = new Map();
for (const row of metricsRows ?? []) {
  if (!row.canonical_slug || metricsBySlug.has(row.canonical_slug)) continue;
  metricsBySlug.set(row.canonical_slug, row);
}

const payload = cards.map((card) => {
  const metrics = metricsBySlug.get(card.slug) ?? null;
  const { changePct, changeLabel } = formatSingleWindowLabel(metrics?.change_pct_24h ?? null, metrics?.change_pct_7d ?? null);
  const summary = buildPopAlphaScoutSummary({
    cardName: card.canonical_name,
    marketPrice: metrics?.market_price ?? null,
    fairValue: metrics?.trimmed_median_30d ?? metrics?.median_30d ?? null,
    changePct,
    changeLabel,
    activeListings7d: metrics?.active_listings_7d ?? null,
  });

  return {
    card_slug: card.slug,
    summary_short: summary.summaryShort,
    summary_long: summary.summaryLong,
  };
});

const { error: upsertError } = await supabase
  .from("card_profiles")
  .upsert(payload, { onConflict: "card_slug" });

if (upsertError) {
  throw new Error(`Failed upserting card_profiles: ${upsertError.message}`);
}

console.log(JSON.stringify({ ok: true, setName, found: cards.length, upserted: payload.length }));

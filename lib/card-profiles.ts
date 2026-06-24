import "server-only";

import { dbAdmin } from "@/lib/db/admin";
import { isLowDollarProfile, lowDollarProfileContent } from "@/lib/ai/card-profile-fallback";

export type CardProfileSummary = {
  summary_short: string;
  summary_long: string | null;
  updated_at: string | null;
};

export type CardProfileDetail = CardProfileSummary & {
  canonical_slug: string;
  signal_label: string | null;
  verdict: string | null;
  chip: string | null;
  created_at: string;
};

export async function loadCardProfileSummary(slug: string): Promise<CardProfileSummary | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("card_profiles")
    .select("summary_short, summary_long, updated_at")
    .eq("canonical_slug", slug)
    .maybeSingle<CardProfileSummary>();

  if (error) {
    throw new Error(`Failed reading card profile summary: ${error.message}`);
  }

  return data ?? null;
}

/**
 * Current canonical RAW Market Price for a slug — the same number the card-
 * detail hero leads with. Gates the low-dollar read-time neutralizer below.
 * Best-effort: a missing/erroring metrics row returns null, so the cached
 * profile is served unchanged.
 */
async function loadCurrentMarketPrice(
  supabase: ReturnType<typeof dbAdmin>,
  slug: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("public_card_metrics")
    .select("market_price")
    .eq("canonical_slug", slug)
    .eq("grade", "RAW")
    .is("printing_id", null)
    .maybeSingle<{ market_price: number | null }>();
  return typeof data?.market_price === "number" ? data.market_price : null;
}

export async function loadCardProfileDetail(slug: string): Promise<CardProfileDetail | null> {
  const supabase = dbAdmin();
  const { data, error } = await supabase
    .from("card_profiles")
    .select("canonical_slug, signal_label, verdict, chip, summary_short, summary_long, updated_at, created_at")
    .eq("canonical_slug", slug)
    .maybeSingle<CardProfileDetail>();

  if (error) {
    throw new Error(`Failed reading card profile detail: ${error.message}`);
  }
  if (!data) return null;

  // Read-time low-dollar neutralizer. Many cached profiles predate the low-
  // dollar floor (or froze a stale/contaminated price), so a $0.01 card can
  // still serve "$0.86, -50%" prose. If the card's CURRENT Market Price is
  // low-dollar, override with the SAME deterministic note generation now
  // produces — instant for every installed app version, no waiting for the
  // cron to re-walk the catalog. One indexed lookup; best-effort.
  const currentPrice = await loadCurrentMarketPrice(supabase, slug);
  if (isLowDollarProfile(currentPrice)) {
    const c = lowDollarProfileContent();
    return {
      ...data,
      signal_label: c.signalLabel,
      verdict: c.verdict,
      chip: c.chip,
      summary_short: c.summaryShort,
      summary_long: c.summaryLong,
    };
  }

  return data;
}

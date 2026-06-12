/**
 * Cron: check-jp-source-divergence
 *
 * Standing detector for JP price contamination, born from the 2026-06-11
 * source-divergence audit. Two independent JP-native sources price the same
 * cards: Yahoo! Auctions JP (query-matched at scrape time) and Snkrdunk
 * (mapped via snkrdunk_product_map). When both have a well-sampled latest
 * RAW price for a slug and the prices disagree by >= 5x, one of them is
 * almost certainly wrong — the audit's confirmed classes are Yahoo printing
 * fan-out (pre-#237 number-mismatch filter) and Snkrdunk true mismaps (e.g.
 * a ~$5 card mapped to a ~$564 alt-art via a name-prefix + card-number
 * coincidence, promoted by the blanket 'audit-era-promote-2026-05-15' batch).
 *
 * Compares the canonical-level rollup rows (printing_id IS NULL, grade RAW)
 * — the same rows public_card_metrics falls back to — with sample-count
 * gates so thin medians don't page anyone. A structural residual class
 * remains even with healthy data (Yahoo medians lean ask-vs-sold / outlier
 * heavy on sparse cards), so the alert fires on COUNT, not on any single
 * offender.
 *
 * Mirrors check-pricecharting-freshness: FAILS LOUD with HTTP 500 (Vercel's
 * cron-failure alerting) when the divergent count exceeds the threshold;
 * the JSON body carries the top offenders (slug, both prices, samples,
 * ratio, snkrdunk product name) so the operator can verify and quarantine
 * with scripts/jp-mapping-quarantine.mjs.
 *
 * Secondary metric (fan-out census): groups of same-name sibling slugs whose
 * latest Yahoo rows share an IDENTICAL (price_usd, sample_count) pair — the
 * signature of one Yahoo query fanning out across printings/sets. Computed
 * in-process from rows already fetched (plus a bounded canonical_cards name
 * lookup), informational only — it never trips the alert.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

// Sample gates: Yahoo medians firm up around n>=5; Snkrdunk's own docs treat
// n<3 as low confidence (snkrdunk_card_prices.sample_count column comment).
const YAHOO_MIN_SAMPLE_COUNT = 5;
const SNKRDUNK_MIN_SAMPLE_COUNT = 3;
// greatest/least — direction-agnostic. 5x is far beyond honest marketplace
// spread (ask-vs-sold, JP-vs-EN premium are ~1.2-2x).
const DIVERGENCE_RATIO_THRESHOLD = 5;
// Alert threshold rationale: the audit measured 281 divergent pairs pre-#237
// (re-measured 279 on 2026-06-11, day one of this check, 634 eligible
// pairs). After the #237 Yahoo number-mismatch filter deploys and confirmed
// mismaps are quarantined, the steady state should fall well below 100,
// with a structural ask-vs-sold residual class well below that. 60 gives
// headroom above the structural baseline while still catching a regression
// of either contamination class (a matcher change, a blanket promote, a
// filter rollback) long before it approaches audit-era levels. Tune as the
// post-#237 steady state becomes known.
const ALERT_DIVERGENT_COUNT = 60;

const PAGE_SIZE = 1000;
const TOP_OFFENDER_LIMIT = 20;
const NAME_LOOKUP_CHUNK_SIZE = 200;
// Fan-out census cost cap: the name lookup is the only extra query weight,
// so skip the census (informational anyway) rather than blow the budget if
// shared-price groups ever cover an absurd slug count.
const FANOUT_CENSUS_MAX_LOOKUP_SLUGS = 4000;

type LatestPriceRow = {
  canonical_slug: string;
  price_usd: number | null;
  sample_count: number | null;
};

type Offender = {
  canonicalSlug: string;
  yahooUsd: number;
  snkrdunkUsd: number;
  yahooSamples: number;
  snkrdunkSamples: number;
  ratio: number;
  snkrdunkName: string | null;
};

async function fetchLatestRawRollups(
  supabase: ReturnType<typeof dbAdmin>,
  table: "yahoo_jp_card_prices" | "snkrdunk_card_prices",
  minSampleCount: number,
): Promise<LatestPriceRow[]> {
  const rows: LatestPriceRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select("canonical_slug, price_usd, sample_count")
      .eq("grade", "RAW")
      .is("printing_id", null)
      .gt("price_usd", 0)
      .gte("sample_count", minSampleCount)
      .order("canonical_slug", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
      .returns<LatestPriceRow[]>();
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function GET(req: Request) {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.response;

  const supabase = dbAdmin();

  try {
    // 1. Latest RAW canonical-level rollups from both sources. These tables
    //    are UPSERT-in-place (one row per slug+printing+grade), so the row
    //    IS the latest observation.
    const [yahooRows, snkrdunkRows] = await Promise.all([
      fetchLatestRawRollups(supabase, "yahoo_jp_card_prices", YAHOO_MIN_SAMPLE_COUNT),
      fetchLatestRawRollups(supabase, "snkrdunk_card_prices", SNKRDUNK_MIN_SAMPLE_COUNT),
    ]);

    // 2. Join per slug, compute greatest/least ratio.
    const snkrdunkBySlug = new Map<string, LatestPriceRow>();
    for (const row of snkrdunkRows) snkrdunkBySlug.set(row.canonical_slug, row);

    const offenders: Offender[] = [];
    let eligiblePairs = 0;
    for (const yahoo of yahooRows) {
      const snk = snkrdunkBySlug.get(yahoo.canonical_slug);
      if (!snk) continue;
      const yahooUsd = Number(yahoo.price_usd);
      const snkUsd = Number(snk.price_usd);
      if (!Number.isFinite(yahooUsd) || !Number.isFinite(snkUsd) || yahooUsd <= 0 || snkUsd <= 0) continue;
      eligiblePairs += 1;
      const ratio = Math.max(yahooUsd, snkUsd) / Math.min(yahooUsd, snkUsd);
      if (ratio < DIVERGENCE_RATIO_THRESHOLD) continue;
      offenders.push({
        canonicalSlug: yahoo.canonical_slug,
        yahooUsd,
        snkrdunkUsd: snkUsd,
        yahooSamples: yahoo.sample_count ?? 0,
        snkrdunkSamples: snk.sample_count ?? 0,
        ratio: Math.round(ratio * 10) / 10,
        snkrdunkName: null,
      });
    }
    offenders.sort((a, b) => b.ratio - a.ratio);
    const topOffenders = offenders.slice(0, TOP_OFFENDER_LIMIT);

    // 3. Snkrdunk product name for the top offenders — one cheap keyed
    //    lookup; the name usually makes the mismap obvious at a glance
    //    (wrong card name / wrong set bracket on an expensive product).
    if (topOffenders.length > 0) {
      const { data, error } = await supabase
        .from("snkrdunk_product_map")
        .select("canonical_slug, snkrdunk_name")
        .in("canonical_slug", topOffenders.map((o) => o.canonicalSlug))
        .returns<{ canonical_slug: string; snkrdunk_name: string | null }[]>();
      if (error) throw new Error(`snkrdunk_product_map: ${error.message}`);
      const nameBySlug = new Map((data ?? []).map((r) => [r.canonical_slug, r.snkrdunk_name]));
      for (const offender of topOffenders) {
        offender.snkrdunkName = nameBySlug.get(offender.canonicalSlug) ?? null;
      }
    }

    // 4. Fan-out census (informational): same-name siblings sharing an
    //    identical latest Yahoo (price_usd, sample_count) pair.
    const fanOutCensus = await computeYahooFanOutCensus(supabase, yahooRows);

    const divergentCount = offenders.length;
    const alert = divergentCount > ALERT_DIVERGENT_COUNT;
    const payload = {
      ok: !alert,
      divergentCount,
      eligiblePairs,
      alertThreshold: ALERT_DIVERGENT_COUNT,
      ratioThreshold: DIVERGENCE_RATIO_THRESHOLD,
      yahooMinSampleCount: YAHOO_MIN_SAMPLE_COUNT,
      snkrdunkMinSampleCount: SNKRDUNK_MIN_SAMPLE_COUNT,
      topOffenders,
      fanOutCensus,
      remediation: alert
        ? "Verify the top offenders (snkrdunkName vs the canonical card), then quarantine confirmed mismaps with scripts/jp-mapping-quarantine.mjs --slugs=<...> --source=<snkrdunk|yahoo_jp|both> --apply. Yahoo-side offenders also need the PR #237 number-mismatch filter live or they re-contaminate hourly."
        : null,
    };

    console[alert ? "error" : "info"]("[check-jp-source-divergence] summary", JSON.stringify(payload));
    return NextResponse.json(payload, { status: alert ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[check-jp-source-divergence] check failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

type FanOutCensus = {
  skipped: boolean;
  skippedReason: string | null;
  groupCount: number;
  slugsInGroups: number;
  sampleGroups: {
    canonicalName: string;
    slugCount: number;
    priceUsd: number;
    sampleCount: number;
    sampleSlugs: string[];
  }[];
};

async function computeYahooFanOutCensus(
  supabase: ReturnType<typeof dbAdmin>,
  yahooRows: LatestPriceRow[],
): Promise<FanOutCensus> {
  const empty: FanOutCensus = {
    skipped: false,
    skippedReason: null,
    groupCount: 0,
    slugsInGroups: 0,
    sampleGroups: [],
  };

  // Group already-fetched rows by exact (price_usd, sample_count). Only
  // groups of >= 2 slugs can be fan-out, so the DB cost below is bounded to
  // their members.
  const byPriceSample = new Map<string, LatestPriceRow[]>();
  for (const row of yahooRows) {
    const key = `${row.price_usd}|${row.sample_count}`;
    const bucket = byPriceSample.get(key);
    if (bucket) bucket.push(row);
    else byPriceSample.set(key, [row]);
  }
  const sharedGroups = [...byPriceSample.values()].filter((rows) => rows.length >= 2);
  if (sharedGroups.length === 0) return empty;

  const candidateSlugs = [...new Set(sharedGroups.flat().map((row) => row.canonical_slug))];
  if (candidateSlugs.length > FANOUT_CENSUS_MAX_LOOKUP_SLUGS) {
    return {
      ...empty,
      skipped: true,
      skippedReason: `${candidateSlugs.length} slugs share a (price, sample_count) pair — name lookup too heavy, census skipped`,
    };
  }

  // Same-name requirement: identical-price coincidences across unrelated
  // cards are common at low price points; fan-out specifically clones one
  // product's median across same-name printings/sets.
  const nameBySlug = new Map<string, string | null>();
  for (let index = 0; index < candidateSlugs.length; index += NAME_LOOKUP_CHUNK_SIZE) {
    const chunk = candidateSlugs.slice(index, index + NAME_LOOKUP_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name")
      .in("slug", chunk)
      .returns<{ slug: string; canonical_name: string | null }[]>();
    if (error) throw new Error(`canonical_cards: ${error.message}`);
    for (const row of data ?? []) nameBySlug.set(row.slug, row.canonical_name);
  }

  let groupCount = 0;
  let slugsInGroups = 0;
  const sampleGroups: FanOutCensus["sampleGroups"] = [];
  for (const rows of sharedGroups) {
    const byName = new Map<string, LatestPriceRow[]>();
    for (const row of rows) {
      const name = nameBySlug.get(row.canonical_slug);
      if (!name) continue;
      const bucket = byName.get(name);
      if (bucket) bucket.push(row);
      else byName.set(name, [row]);
    }
    for (const [name, members] of byName) {
      if (members.length < 2) continue;
      groupCount += 1;
      slugsInGroups += members.length;
      sampleGroups.push({
        canonicalName: name,
        slugCount: members.length,
        priceUsd: Number(members[0].price_usd),
        sampleCount: members[0].sample_count ?? 0,
        sampleSlugs: members.slice(0, 3).map((row) => row.canonical_slug),
      });
    }
  }
  sampleGroups.sort((a, b) => b.slugCount - a.slugCount);

  return {
    skipped: false,
    skippedReason: null,
    groupCount,
    slugsInGroups,
    sampleGroups: sampleGroups.slice(0, 5),
  };
}

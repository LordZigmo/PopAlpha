#!/usr/bin/env node
/**
 * Offline test of lib/jp/matcher.mjs against the saved Day 1 scraper
 * output. Pretends the scraped data came from a precision-query, runs
 * the matcher targeting a known canonical_card mock, and prints what
 * the matcher would emit.
 *
 * Usage:
 *   node scripts/test-matcher-offline.mjs
 */

import fs from "node:fs";
import { buildPrecisionQuery, selectMatched } from "../lib/jp/matcher.mjs";

// Mock canonical_cards rows representing the POST-backfill state. The
// native names are populated as they would be after running
// scripts/backfill-scrydex-jp-native-names.mjs. The Delta Species
// Charizard mock is included to verify the wrong-set-in-title penalty
// correctly rejects さいはての攻防 listings when canonical's set is 拡張パック.
const TEST_CARDS = [
  {
    slug: "expansion-pack-6-charizard-jp",
    canonical_name: "Charizard",
    canonical_name_native: "リザードン",
    set_name: "Expansion Pack",
    set_name_native: "拡張パック",
    card_number: "6",
    year: 1996,
    language: "JP",
  },
  {
    slug: "leaders-stadium-2-blaines-charizard-jp",
    canonical_name: "Blaine's Charizard",
    canonical_name_native: "カツラのリザードン",
    set_name: "Leaders Stadium",
    set_name_native: "リーダーズスタジアム",
    card_number: "2",
    year: 2000,
    language: "JP",
  },
  {
    slug: "team-rocket-25-dark-charizard-jp",
    canonical_name: "Dark Charizard",
    canonical_name_native: "わるいリザードン",
    set_name: "Team Rocket",
    set_name_native: "ロケット団",
    card_number: "25",
    year: 1997,
    language: "JP",
  },
  // Negative-control case: Delta Species Charizard. Should NOT match
  // listings whose title contains 拡張パック alone (Base Set generic
  // marker), and SHOULD match listings whose title contains さいはての攻防.
  {
    slug: "offense-and-defense-100-charizard-jp",
    canonical_name: "Charizard δ",
    canonical_name_native: "リザードン δ",
    set_name: "Offense and Defense of the Furthest Ends",
    set_name_native: "さいはての攻防",
    card_number: "100",
    year: 2006,
    language: "JP",
  },
];

const QUERY_FILES = [
  { file: "/tmp/yahoo-jp-validation/q1.json", scrapedQuery: "リザードン 旧裏 (broad)" },
];

function main() {
  for (const file of QUERY_FILES) {
    const raw = JSON.parse(fs.readFileSync(file.file, "utf-8"));
    const listings = raw.listings ?? [];
    console.log(`\n${"=".repeat(80)}`);
    console.log(`SCRAPED FILE: ${file.file}`);
    console.log(`Original scrape query: "${file.scrapedQuery}"`);
    console.log(`Listings in file: ${listings.length}\n`);

    for (const card of TEST_CARDS) {
      const query = buildPrecisionQuery(card);
      const result = selectMatched(listings, card, { minScore: 0.50 });

      console.log(`-`.repeat(80));
      console.log(`CANONICAL: ${card.slug}`);
      console.log(`  EN: ${card.canonical_name} | set: ${card.set_name} | #${card.card_number} | year: ${card.year}`);
      console.log(`  Constructed JP query: "${query.query}"`);
      console.log(`  Query parts: pokemon=${query.parts.pokemonToken ?? "—"} set=${query.parts.setToken ?? "—"} era=${query.parts.eraToken ?? "—"}`);
      console.log(`  Pipeline: scraped=${result.inputCount} → afterExclusion=${result.afterExclusion} → accepted=${result.accepted}`);
      console.log(`  Tiers: HIGH=${result.tiers.HIGH}  MEDIUM=${result.tiers.MEDIUM}  LOW=${result.tiers.LOW}`);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) console.log(`  ⚠ ${w}`);
      }
      if (result.priceObservations.length > 0) {
        console.log(`  Price observations:`);
        for (const obs of result.priceObservations) {
          console.log(`    [${obs.grade.padEnd(15)}] n=${obs.count} median=¥${obs.median.toLocaleString("en-US")}  p25=¥${obs.p25.toLocaleString("en-US")}  p75=¥${obs.p75.toLocaleString("en-US")}`);
        }
      } else {
        console.log(`  (no price observations produced)`);
      }
      // Show 2 highest-scoring matches and 2 highest-scoring rejections for inspection
      const allScored = result.detail?.tiers
        ? [...result.detail.tiers.HIGH, ...result.detail.tiers.MEDIUM, ...result.detail.tiers.LOW]
        : [];
      const sortedDesc = [...allScored].sort((a, b) => b.score - a.score);
      const topAccepted = sortedDesc.filter((s) => s.score >= 0.5).slice(0, 2);
      const topRejected = sortedDesc.filter((s) => s.score < 0.5).slice(0, 2);
      if (topAccepted.length > 0) {
        console.log(`  TOP MATCHES:`);
        for (const s of topAccepted) {
          console.log(`    [${s.tier} ${s.score.toFixed(2)}] ¥${s.listing.price?.toLocaleString("en-US")} ${s.listing.title.slice(0, 70)}`);
          console.log(`       reasons: ${s.reasons.join(" ; ")}`);
        }
      }
      if (topRejected.length > 0) {
        console.log(`  TOP REJECTIONS (low score):`);
        for (const s of topRejected) {
          console.log(`    [${s.tier} ${s.score.toFixed(2)}] ¥${s.listing.price?.toLocaleString("en-US")} ${s.listing.title.slice(0, 70)}`);
          console.log(`       reasons: ${s.reasons.join(" ; ")}`);
        }
      }
      console.log("");
    }
  }
}

main();

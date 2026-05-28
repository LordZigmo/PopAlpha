#!/usr/bin/env node

import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_SLUGS = [
  "evolving-skies-65-espeon-vmax",
  "burning-shadows-41-raichu",
  "151-17-pidgeotto",
  "base-set-4-charizard",
  "surging-sparks-238-pikachu-ex",
];

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function env(name) {
  return process.env[name]?.trim() || null;
}

function parseFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "").replace(/[$,\s]/g, "");
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

async function loadManualReferences(csvPath) {
  if (!csvPath) return new Map();
  const raw = await fs.readFile(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return new Map();
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    const slug = String(row.canonical_slug ?? row.slug ?? "").trim();
    if (!slug) continue;
    rows.set(slug, {
      slug,
      tcgplayerPrice: parseFinite(row.tcgplayer_price ?? row.tcgplayer ?? null),
      ebayRecentLow: parseFinite(row.ebay_recent_low ?? row.ebay_low ?? null),
      ebayRecentHigh: parseFinite(row.ebay_recent_high ?? row.ebay_high ?? null),
      notes: String(row.notes ?? "").trim() || null,
    });
  }
  return rows;
}

function withinTolerance(popalphaPrice, referencePrice, tolerancePct, minDollarTolerance) {
  if (popalphaPrice === null || referencePrice === null || referencePrice <= 0) return null;
  const absoluteDelta = Math.abs(popalphaPrice - referencePrice);
  const tolerance = Math.max(minDollarTolerance, referencePrice * (tolerancePct / 100));
  return {
    ok: absoluteDelta <= tolerance,
    deltaPct: ((popalphaPrice - referencePrice) / referencePrice) * 100,
    absoluteDelta,
    tolerance,
  };
}

function compareAgainstReference(popalphaPrice, reference, tolerancePct, minDollarTolerance) {
  const checks = [];
  const tcg = withinTolerance(popalphaPrice, reference?.tcgplayerPrice ?? null, tolerancePct, minDollarTolerance);
  if (tcg) checks.push({ source: "tcgplayer", ...tcg });

  const low = reference?.ebayRecentLow ?? null;
  const high = reference?.ebayRecentHigh ?? null;
  if (popalphaPrice !== null && low !== null && high !== null && low > 0 && high >= low) {
    const inRange = popalphaPrice >= low && popalphaPrice <= high;
    const nearest = popalphaPrice < low ? low : high;
    const rangeCheck = inRange
      ? { ok: true, deltaPct: 0, absoluteDelta: 0, tolerance: 0 }
      : withinTolerance(popalphaPrice, nearest, tolerancePct, minDollarTolerance);
    if (rangeCheck) checks.push({ source: "ebay_recent_range", ...rangeCheck });
  }

  if (!reference || checks.length === 0) return { status: "NEEDS_MANUAL_REFERENCE", checks };
  if (popalphaPrice === null) return { status: "NO_PUBLIC_PRICE", checks };
  if (checks.every((check) => check.ok)) return { status: "PASS", checks };
  if (checks.some((check) => check.ok)) return { status: "REVIEW_MIXED_REFERENCE", checks };
  return { status: "FAIL_REVIEW_PRICE", checks };
}

function publicStatusFromProvenance(provenance) {
  if (!provenance || typeof provenance !== "object") return null;
  return {
    confidenceStatus: provenance.confidenceStatus ?? null,
    publicInputStatus: provenance.publicInputStatus ?? null,
    priceConflictStatus: provenance.priceConflictStatus ?? null,
    internalGuardrailStatus: provenance.internalGuardrailStatus ?? null,
    quarantineReason: provenance.quarantineReason ?? null,
  };
}

async function main() {
  const csvPath = argValue("manual-csv") ?? argValue("csv");
  const tolerancePct = parseFinite(argValue("tolerance-pct", "35")) ?? 35;
  const minDollarTolerance = parseFinite(argValue("min-dollar-tolerance", "1")) ?? 1;
  const manualReferences = await loadManualReferences(csvPath);
  const explicitSlugs = (argValue("slugs") ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  const slugs = [...new Set([
    ...explicitSlugs,
    ...manualReferences.keys(),
    ...(explicitSlugs.length === 0 && manualReferences.size === 0 ? DEFAULT_SLUGS : []),
  ])];
  if (slugs.length === 0) throw new Error("No slugs supplied. Use --slugs=a,b or --manual-csv=spotchecks.csv.");

  const supabaseUrl = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseKey = env("SUPABASE_ANON_KEY") ?? env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase URL/key env. Set SUPABASE_URL plus SUPABASE_ANON_KEY, or the NEXT_PUBLIC equivalents.");
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from("public_card_metrics")
    .select("canonical_slug, market_price, market_price_as_of, market_confidence_score, market_low_confidence, market_blend_policy, market_provenance")
    .in("canonical_slug", slugs)
    .eq("grade", "RAW")
    .is("printing_id", null);
  if (error) throw new Error(`public_card_metrics: ${error.message}`);

  const rowsBySlug = new Map((data ?? []).map((row) => [row.canonical_slug, row]));
  const results = slugs.map((slug) => {
    const row = rowsBySlug.get(slug) ?? null;
    const popalphaPrice = parseFinite(row?.market_price ?? null);
    const reference = manualReferences.get(slug) ?? null;
    const comparison = compareAgainstReference(popalphaPrice, reference, tolerancePct, minDollarTolerance);
    return {
      slug,
      status: row ? comparison.status : "MISSING_POPALPHA_ROW",
      popalphaMarketPrice: popalphaPrice,
      popalphaAsOf: row?.market_price_as_of ?? null,
      confidenceScore: parseFinite(row?.market_confidence_score ?? null),
      lowConfidence: row?.market_low_confidence ?? null,
      blendPolicy: row?.market_blend_policy ?? null,
      publicProvenance: publicStatusFromProvenance(row?.market_provenance ?? null),
      manualReference: reference,
      checks: comparison.checks.map((check) => ({
        source: check.source,
        ok: check.ok,
        deltaPct: Number(check.deltaPct.toFixed(2)),
        absoluteDelta: Number(check.absoluteDelta.toFixed(2)),
        tolerance: Number(check.tolerance.toFixed(2)),
      })),
    };
  });

  const summary = {
    checked: results.length,
    pass: results.filter((row) => row.status === "PASS").length,
    review: results.filter((row) => row.status.startsWith("REVIEW") || row.status.startsWith("FAIL")).length,
    noPublicPrice: results.filter((row) => row.status === "NO_PUBLIC_PRICE").length,
    needsManualReference: results.filter((row) => row.status === "NEEDS_MANUAL_REFERENCE").length,
    missingPopAlphaRow: results.filter((row) => row.status === "MISSING_POPALPHA_ROW").length,
    tolerancePct,
    minDollarTolerance,
  };

  if (hasFlag("json")) {
    console.log(JSON.stringify({ ok: true, summary, results }, null, 2));
    return;
  }

  console.log(`PopAlpha public price spotcheck: ${summary.checked} cards`);
  console.log(`PASS=${summary.pass} REVIEW=${summary.review} NO_PUBLIC_PRICE=${summary.noPublicPrice} NEEDS_REFERENCE=${summary.needsManualReference} MISSING=${summary.missingPopAlphaRow}`);
  for (const row of results) {
    const price = row.popalphaMarketPrice === null ? "no public price" : `$${row.popalphaMarketPrice.toFixed(2)}`;
    const bits = [
      row.slug,
      row.status,
      price,
      row.blendPolicy ?? "no_policy",
      row.publicProvenance?.confidenceStatus ? `confidence=${row.publicProvenance.confidenceStatus}` : null,
      row.publicProvenance?.quarantineReason ? `reason=${row.publicProvenance.quarantineReason}` : null,
    ].filter(Boolean);
    console.log(`- ${bits.join(" | ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

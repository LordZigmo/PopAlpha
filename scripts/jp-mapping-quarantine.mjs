#!/usr/bin/env node
/**
 * Operator tool: quarantine a confirmed-wrong JP source mapping AND purge
 * the stale price rows it already produced.
 *
 * Motivating incident (2026-06-11 source-divergence audit): the
 * snkrdunk_product_map row for canonical_slug `vstar-universe-105-latias-jp`
 * (a ~$5 card) was matched to "Latias & Latios GX SR: SA [SM9 105/095]
 * (Tag Bolt)" — a ~$564 alt-art. The match passed on a name-prefix
 * ("latias & latios gx".startsWith("latias ")-style), a number-105
 * coincidence, and era-window slack, and was then promoted to MATCHED by
 * the blanket batch tagged reviewed_by='audit-era-promote-2026-05-15'
 * (1,189 rows, every one a weak score-0.6 name+number-only match).
 *
 * Why a dedicated script: scripts/snkrdunk-era-audit-cleanup.mjs (and any
 * manual UPDATE) only flips snkrdunk_product_map.mapping_status. That stops
 * FUTURE ingestion (Step D skips REJECTED rows permanently) but leaves the
 * poison behind:
 *   - snkrdunk_card_prices rows are UPSERT-keyed (canonical_slug,
 *     printing_id, grade) and never expire — a rejected map leaves a stale
 *     "latest price" forever.
 *   - jp_card_price_history rows keep feeding the hourly
 *     refresh-jp-price-display cron's 14-day median for up to 14 days.
 * This script does the full job: REJECT the map row (snkrdunk only — Yahoo
 * has no mapping table) and DELETE both price surfaces for the slug.
 *
 * Recovery after --apply is automatic: the hourly refresh-jp-price-display
 * cron recomputes jp_display_price from whatever history remains, and
 * compute_jp_card_price_changes' stale-wipe clears the change badges. The
 * slug shows NO JP price until honestly re-scraped — that is the intended
 * conservative outcome (north star: never show a number we can't defend).
 *
 * Yahoo! JP caveat: Yahoo matches by SEARCH QUERY at scrape time, not via a
 * mapping table, so there is nothing to reject. Until the PR #237
 * number-mismatch filter is deployed, the next hourly run-yahoo-jp-daily
 * tick can simply rewrite the contamination this script deletes. The script
 * prints a loud warning to that effect when --source includes yahoo_jp.
 *
 * Safety shape (mirrors scripts/snkrdunk-era-audit-cleanup.mjs):
 *   - Dry-run by default: counts and prints exactly what would change.
 *   - --apply to mutate. Batched updates/deletes.
 *   - Idempotent: re-running after --apply finds 0 rows to touch (map rows
 *     already REJECTED are skipped so prior reviewed_at/reviewed_by
 *     provenance is never clobbered; deleted rows are simply gone).
 *
 * Usage:
 *   node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --slugs=<a,b,c> [--source=snkrdunk|yahoo_jp|both] [--apply]
 *   node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --map-ids=<uuid,...> [--source=...] [--apply]
 *
 * Examples:
 *   # Inspect what quarantining one slug's Snkrdunk data would touch
 *   node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --slugs=<slug>
 *
 *   # Apply: reject the Snkrdunk map + purge its price rows
 *   node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --slugs=<slug> --apply
 *
 *   # Purge Yahoo!JP contamination for two slugs (read the warning first)
 *   node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --slugs=<a>,<b> --source=yahoo_jp --apply
 */

import { createClient } from "@supabase/supabase-js";

const VALID_SOURCES = ["snkrdunk", "yahoo_jp", "both"];
const SLUG_CHUNK = 100; // slugs per .in() filter
const PAGE = 1000; // rows per page when counting via select
const UPDATE_BATCH = 200; // map ids per UPDATE batch (mirrors era-audit script)
const REVIEWED_BY = `jp-mapping-quarantine-${new Date().toISOString().slice(0, 10)}`;

const USAGE = `Usage:
  node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --slugs=<a,b,c> [--source=snkrdunk|yahoo_jp|both] [--apply]
  node --env-file=.env.local scripts/jp-mapping-quarantine.mjs --map-ids=<uuid,...> [--source=...] [--apply]

Flags:
  --slugs=a,b,c     Comma-separated canonical_slugs to quarantine.
  --map-ids=u1,u2   Comma-separated snkrdunk_product_map.id UUIDs; resolved
                    to their canonical_slugs (snkrdunk map only — Yahoo has
                    no mapping table). May be combined with --slugs.
  --source=...      snkrdunk (default) | yahoo_jp | both.
                    snkrdunk: REJECT snkrdunk_product_map row(s) + DELETE
                      snkrdunk_card_prices (all grades/printings) + DELETE
                      jp_card_price_history rows with source='snkrdunk'.
                    yahoo_jp: DELETE yahoo_jp_card_prices (all grades) +
                      DELETE jp_card_price_history rows with source='yahoo_jp'.
                      No map table to reject — see the warning the script
                      prints about pre-#237 re-contamination.
  --apply           Write changes. Default is a read-only dry run.
  --help            Print this message.

Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (load via
node --env-file=.env.local).`;

// ---------------------------------------------------------------------------
// Argument parsing — strict: unknown flags are an error, not a silent no-op,
// because this script deletes rows.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { slugs: [], mapIds: [], source: "snkrdunk", apply: false, help: false };
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") {
      args.help = true;
    } else if (raw === "--apply") {
      args.apply = true;
    } else if (raw.startsWith("--slugs=")) {
      args.slugs.push(
        ...raw
          .slice("--slugs=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (raw.startsWith("--map-ids=")) {
      args.mapIds.push(
        ...raw
          .slice("--map-ids=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (raw.startsWith("--source=")) {
      args.source = raw.slice("--source=".length).trim();
    } else {
      throw new Error(`Unknown argument: ${raw}\n\n${USAGE}`);
    }
  }
  if (args.help) return args;
  if (!VALID_SOURCES.includes(args.source)) {
    throw new Error(`--source must be one of ${VALID_SOURCES.join("|")} (got "${args.source}")\n\n${USAGE}`);
  }
  if (args.slugs.length === 0 && args.mapIds.length === 0) {
    throw new Error(`Nothing to do: pass --slugs=... and/or --map-ids=...\n\n${USAGE}`);
  }
  return args;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Count rows per canonical_slug for (table, slugs, extra filters) by paging
// a slug-only projection. Latest-price tables hold at most a handful of rows
// per slug (per-grade × per-printing) and history holds bounded scrape-tick
// rows (90d retention), so paging the projection is cheap and gives exact
// per-slug counts for the dry-run report.
async function countBySlug(sb, table, slugs, applyFilters) {
  const counts = new Map(slugs.map((s) => [s, 0]));
  for (const slugBatch of chunk(slugs, SLUG_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      let q = sb.from(table).select("canonical_slug").in("canonical_slug", slugBatch);
      if (applyFilters) q = applyFilters(q);
      // Stable order across pages (same reasoning as the era-audit script:
      // unordered range() pagination can duplicate or skip rows).
      const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} count query failed: ${error.message}`);
      for (const row of data ?? []) counts.set(row.canonical_slug, (counts.get(row.canonical_slug) ?? 0) + 1);
      if (!data || data.length < PAGE) break;
    }
  }
  return counts;
}

async function deleteBySlug(sb, table, slugs, applyFilters) {
  let deleted = 0;
  for (const slugBatch of chunk(slugs, SLUG_CHUNK)) {
    let q = sb.from(table).delete({ count: "exact" }).in("canonical_slug", slugBatch);
    if (applyFilters) q = applyFilters(q);
    const { count, error } = await q;
    if (error) throw new Error(`${table} delete failed: ${error.message}`);
    deleted += count ?? 0;
  }
  return deleted;
}

function printYahooWarning() {
  console.log();
  console.log("!".repeat(78));
  console.log("!! YAHOO_JP WARNING");
  console.log("!! Yahoo!JP has NO mapping table — it matches by search query on every");
  console.log("!! hourly run-yahoo-jp-daily tick. Until the PR #237 number-mismatch");
  console.log("!! filter is DEPLOYED, the next tick may simply REWRITE the contamination");
  console.log("!! this purge removes. Run yahoo_jp quarantines after #237 is live (or");
  console.log("!! expect to re-run this script).");
  console.log("!! Post-purge, the slug shows NO JP price until honestly re-scraped —");
  console.log("!! that is the intended conservative outcome.");
  console.log("!".repeat(78));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Run with: node --env-file=.env.local scripts/jp-mapping-quarantine.mjs ...",
    );
    process.exit(1);
  }
  const sb = createClient(url, key);

  const sources = args.source === "both" ? ["snkrdunk", "yahoo_jp"] : [args.source];

  console.log(`Mode   : ${args.apply ? "APPLY (writes to DB)" : "DRY RUN (read-only)"}`);
  console.log(`Source : ${sources.join(", ")}`);

  // ── Resolve --map-ids → canonical_slugs ─────────────────────────────────
  const slugSet = new Set(args.slugs);
  if (args.mapIds.length > 0) {
    const found = new Map();
    for (const idBatch of chunk(args.mapIds, SLUG_CHUNK)) {
      const { data, error } = await sb
        .from("snkrdunk_product_map")
        .select("id, canonical_slug")
        .in("id", idBatch);
      if (error) throw new Error(`snkrdunk_product_map id lookup failed: ${error.message}`);
      for (const row of data ?? []) found.set(row.id, row.canonical_slug);
    }
    const missing = args.mapIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`--map-ids not found in snkrdunk_product_map: ${missing.join(", ")}`);
    }
    for (const slug of found.values()) slugSet.add(slug);
  }
  const slugs = [...slugSet].sort();
  console.log(`Targets: ${slugs.length} slug(s)`);
  for (const s of slugs) console.log(`  - ${s}`);
  console.log();

  if (sources.includes("yahoo_jp")) printYahooWarning();

  // ── Count phase (also the entire dry-run output) ────────────────────────
  // summary[label] = { total, bySlug: Map }
  const plan = [];

  let mapRows = [];
  if (sources.includes("snkrdunk")) {
    // Map rows to flip. Rows already REJECTED are skipped (idempotency +
    // never clobber an earlier reviewer's reviewed_at/reviewed_by stamp).
    const allMapRows = [];
    for (const slugBatch of chunk(slugs, SLUG_CHUNK)) {
      const { data, error } = await sb
        .from("snkrdunk_product_map")
        .select("id, canonical_slug, mapping_status, match_score, snkrdunk_name")
        .in("canonical_slug", slugBatch);
      if (error) throw new Error(`snkrdunk_product_map lookup failed: ${error.message}`);
      allMapRows.push(...(data ?? []));
    }
    mapRows = allMapRows.filter((r) => r.mapping_status !== "REJECTED");
    const alreadyRejected = allMapRows.length - mapRows.length;

    console.log("snkrdunk_product_map rows to flip → REJECTED:");
    if (mapRows.length === 0) console.log("  (none — already REJECTED or no map row)");
    for (const r of mapRows) {
      console.log(
        `  ${r.canonical_slug.padEnd(45)} ${String(r.mapping_status).padEnd(13)} score=${r.match_score ?? "-"} ${String(r.snkrdunk_name ?? "").slice(0, 70)}`,
      );
    }
    if (alreadyRejected > 0) console.log(`  (${alreadyRejected} already REJECTED — skipped)`);
    console.log();

    plan.push({
      label: "snkrdunk_product_map → REJECTED",
      total: mapRows.length,
      bySlug: new Map(slugs.map((s) => [s, mapRows.filter((r) => r.canonical_slug === s).length])),
    });
    plan.push({
      label: "snkrdunk_card_prices DELETE",
      total: null,
      bySlug: await countBySlug(sb, "snkrdunk_card_prices", slugs),
    });
    plan.push({
      label: "jp_card_price_history DELETE (source=snkrdunk)",
      total: null,
      bySlug: await countBySlug(sb, "jp_card_price_history", slugs, (q) => q.eq("source", "snkrdunk")),
    });
  }

  if (sources.includes("yahoo_jp")) {
    plan.push({
      label: "yahoo_jp_card_prices DELETE",
      total: null,
      bySlug: await countBySlug(sb, "yahoo_jp_card_prices", slugs),
    });
    plan.push({
      label: "jp_card_price_history DELETE (source=yahoo_jp)",
      total: null,
      bySlug: await countBySlug(sb, "jp_card_price_history", slugs, (q) => q.eq("source", "yahoo_jp")),
    });
  }

  for (const p of plan) {
    if (p.total == null) p.total = [...p.bySlug.values()].reduce((a, b) => a + b, 0);
  }

  // Per-slug breakdown — what the quarantine touches, slug by slug.
  console.log("Per-slug row counts:");
  const header = ["canonical_slug", ...plan.map((p) => p.label)];
  console.log("  " + header.map((h, i) => (i === 0 ? h.padEnd(45) : h.padStart(h.length + 2))).join(""));
  for (const s of slugs) {
    const cells = plan.map((p) => String(p.bySlug.get(s) ?? 0).padStart(p.label.length + 2));
    console.log("  " + s.padEnd(45) + cells.join(""));
  }
  const untouched = slugs.filter((s) => plan.every((p) => (p.bySlug.get(s) ?? 0) === 0));
  if (untouched.length > 0) {
    console.log();
    console.log(`WARNING: no rows found anywhere for ${untouched.length} slug(s) (typo? already quarantined?):`);
    for (const s of untouched) console.log(`  - ${s}`);
  }

  if (!args.apply) {
    console.log();
    console.log("Summary (dry-run; pass --apply to write):");
    for (const p of plan) console.log(`  ${p.label.padEnd(48)} ${p.total}`);
    return;
  }

  // ── Apply phase ─────────────────────────────────────────────────────────
  console.log();
  const results = [];

  if (sources.includes("snkrdunk")) {
    let flipped = 0;
    const ids = mapRows.map((r) => r.id);
    for (const batch of chunk(ids, UPDATE_BATCH)) {
      const { error } = await sb
        .from("snkrdunk_product_map")
        .update({
          mapping_status: "REJECTED",
          reviewed_at: new Date().toISOString(),
          reviewed_by: REVIEWED_BY,
        })
        .in("id", batch);
      if (error) throw new Error(`snkrdunk_product_map update failed: ${error.message}`);
      flipped += batch.length;
      console.log(`  rejected map batch ${flipped}/${ids.length}`);
    }
    results.push(["snkrdunk_product_map → REJECTED", flipped]);

    const prices = await deleteBySlug(sb, "snkrdunk_card_prices", slugs);
    console.log(`  deleted ${prices} snkrdunk_card_prices rows`);
    results.push(["snkrdunk_card_prices deleted", prices]);

    const hist = await deleteBySlug(sb, "jp_card_price_history", slugs, (q) => q.eq("source", "snkrdunk"));
    console.log(`  deleted ${hist} jp_card_price_history (snkrdunk) rows`);
    results.push(["jp_card_price_history (snkrdunk) deleted", hist]);
  }

  if (sources.includes("yahoo_jp")) {
    const prices = await deleteBySlug(sb, "yahoo_jp_card_prices", slugs);
    console.log(`  deleted ${prices} yahoo_jp_card_prices rows`);
    results.push(["yahoo_jp_card_prices deleted", prices]);

    const hist = await deleteBySlug(sb, "jp_card_price_history", slugs, (q) => q.eq("source", "yahoo_jp"));
    console.log(`  deleted ${hist} jp_card_price_history (yahoo_jp) rows`);
    results.push(["jp_card_price_history (yahoo_jp) deleted", hist]);
  }

  console.log();
  console.log(`Summary (applied; reviewed_by=${REVIEWED_BY}):`);
  for (const [label, n] of results) console.log(`  ${label.padEnd(48)} ${n}`);
  console.log();
  console.log(
    "Done. The hourly refresh-jp-price-display cron recomputes jp_display_price\n" +
      "from the remaining history on its next tick; compute_jp_card_price_changes'\n" +
      "stale-wipe clears the change badges. No manual metric repair needed.",
  );
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  // Argument/validation errors exit 2 (operator typo); runtime errors exit 1.
  process.exit(String(err?.message ?? "").includes("Usage:") ? 2 : 1);
});

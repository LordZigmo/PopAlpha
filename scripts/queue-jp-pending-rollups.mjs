#!/usr/bin/env node
/**
 * One-shot script: bulk-queue JP rollup keys into pending_rollups.
 *
 * Background: after a JP canonical-import batch + pipeline drain, the
 * pipeline orchestrator under-queues targeted rollups (it only enqueues
 * rollups for variants observed during *this* batch's observations, not
 * everything that needs a fresh public_card_metrics row). For bulk
 * onboarding this leaves most JP canonical_slugs without market metrics.
 *
 * Workaround (proven in prior batches): scan price_history_points for
 * every JP slug, extract distinct (canonical_slug, variant_ref, provider,
 * grade) tuples, and upsert into pending_rollups. The
 * batch-refresh-pipeline-rollups cron then drains them at 4500/run.
 *
 * The "JP" predicate is canonical_cards.language = 'JP' (uppercase).
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[queue-jp-pending-rollups] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 500;

async function loadJpSlugs() {
  const slugs = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug")
      .eq("language", "JP")
      .order("slug")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    slugs.push(...data.map((row) => row.slug));
    if (data.length < PAGE_SIZE) break;
  }
  return slugs;
}

async function loadDistinctVariantTuples(slugs) {
  // price_history_points is ~4M rows; we only want distinct
  // (slug, variant_ref, provider, grade). Page through in slug-chunks
  // to avoid one massive query.
  const dedup = new Map();
  const SLUG_CHUNK = 200;
  let processed = 0;

  for (let i = 0; i < slugs.length; i += SLUG_CHUNK) {
    const slugChunk = slugs.slice(i, i + SLUG_CHUNK);

    // price_history_points has no grade column — Scrydex feeds RAW pricing.
    // Hard-code grade='RAW'; PSA-graded rollups (if any) flow through a
    // separate path. Page within the slug chunk in case any single slug
    // has > 1000 points.
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("price_history_points")
        .select("canonical_slug,variant_ref,provider")
        .in("canonical_slug", slugChunk)
        .order("canonical_slug")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        const slug = String(row.canonical_slug ?? "").trim();
        const variantRef = String(row.variant_ref ?? "").trim();
        const provider = String(row.provider ?? "").trim().toUpperCase();
        const grade = "RAW";
        if (!slug || !variantRef || !provider) continue;
        dedup.set(`${slug}::${variantRef}::${provider}::${grade}`, {
          canonical_slug: slug,
          variant_ref: variantRef,
          provider,
          grade,
        });
      }
      if (data.length < PAGE_SIZE) break;
    }

    processed += slugChunk.length;
    if (processed % 1000 === 0 || processed === slugs.length) {
      console.log(
        `[queue-jp-pending-rollups] scanned ${processed}/${slugs.length} slugs, ${dedup.size} distinct tuples so far`,
      );
    }
  }

  return [...dedup.values()];
}

async function upsertPendingRollups(rows) {
  const nowIso = new Date().toISOString();
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK).map((row) => ({
      canonical_slug: row.canonical_slug,
      variant_ref: row.variant_ref,
      provider: row.provider,
      grade: row.grade,
      queued_at: nowIso,
    }));
    const { error } = await supabase
      .from("pending_rollups")
      .upsert(chunk, {
        onConflict: "canonical_slug,variant_ref,provider,grade",
        ignoreDuplicates: true,
      });
    if (error) {
      throw new Error(`pending_rollups(upsert): ${error.message}`);
    }
    upserted += chunk.length;
    if (upserted % 5000 === 0 || upserted === rows.length) {
      console.log(`[queue-jp-pending-rollups] upserted ${upserted}/${rows.length}`);
    }
  }
  return upserted;
}

async function main() {
  const startedAt = Date.now();
  console.log("[queue-jp-pending-rollups] loading JP canonical_slugs…");
  const slugs = await loadJpSlugs();
  console.log(`[queue-jp-pending-rollups] ${slugs.length} JP canonical_slugs`);

  console.log("[queue-jp-pending-rollups] scanning price_history_points for distinct variant tuples…");
  const tuples = await loadDistinctVariantTuples(slugs);
  console.log(`[queue-jp-pending-rollups] ${tuples.length} distinct (slug,variant_ref,provider,grade) tuples`);

  if (tuples.length === 0) {
    console.log("[queue-jp-pending-rollups] no tuples to queue — exiting");
    return;
  }

  console.log("[queue-jp-pending-rollups] upserting into pending_rollups…");
  const upserted = await upsertPendingRollups(tuples);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    ok: true,
    jp_slugs_scanned: slugs.length,
    distinct_tuples: tuples.length,
    upserted,
    elapsed_seconds: Number(elapsed),
  };
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error("[queue-jp-pending-rollups] FAILED:", error);
  process.exit(1);
});

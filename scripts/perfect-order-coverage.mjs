// Diagnostic: how complete is our Perfect Order catalog coverage?
// Three angles: canonical_cards rows, card_image_embeddings,
// and pricing.

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) { console.error("FATAL: missing Supabase env"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // Q1: How many canonical_cards rows for Perfect Order?
  const { count: canonCount, error: canonErr } = await sb
    .from("canonical_cards")
    .select("slug", { count: "exact", head: true })
    .like("slug", "perfect-order-%");
  console.log(`canonical_cards 'perfect-order-%' count: ${canonCount ?? "ERR: " + canonErr?.message}`);

  // Q1b: Sample some Perfect Order rows
  const { data: canonSample } = await sb
    .from("canonical_cards")
    .select("slug, canonical_name, set_name, card_number, primary_image_url, mirrored_primary_image_url, image_embedded_at, image_embedded_model_version, image_embed_attempts, is_digital, is_digital_only")
    .like("slug", "perfect-order-%")
    .order("slug")
    .limit(5);
  console.log("\nSample canonical_cards rows:");
  for (const r of canonSample ?? []) {
    console.log(`  ${r.slug} | set=${r.set_name} | #${r.card_number}`);
    console.log(`    mirror=${r.mirrored_primary_image_url ? "yes" : "NO"} | embed_at=${r.image_embedded_at ? r.image_embedded_at.slice(0, 10) : "NULL"} | embed_variant=${r.image_embedded_model_version ?? "NULL"} | attempts=${r.image_embed_attempts}`);
  }

  // Q2: card_image_embeddings coverage for Perfect Order
  const { count: embedCount, error: embedErr } = await sb
    .from("card_image_embeddings")
    .select("canonical_slug", { count: "exact", head: true })
    .like("canonical_slug", "perfect-order-%");
  console.log(`\ncard_image_embeddings 'perfect-order-%' count: ${embedCount ?? "ERR: " + embedErr?.message}`);

  // Q2b: Per-(model, crop) breakdown
  const { data: embedSample } = await sb
    .from("card_image_embeddings")
    .select("canonical_slug, model_version, crop_type")
    .like("canonical_slug", "perfect-order-%");
  const grouped = {};
  for (const r of embedSample ?? []) {
    const k = `${r.model_version} | ${r.crop_type}`;
    grouped[k] = (grouped[k] ?? 0) + 1;
  }
  console.log("Breakdown by (model_version, crop_type):");
  for (const [k, v] of Object.entries(grouped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(50)} ${v}`);
  }

  // Q3: distinct slugs covered under SigLIP
  const { data: siglipSlugs } = await sb
    .from("card_image_embeddings")
    .select("canonical_slug")
    .like("canonical_slug", "perfect-order-%")
    .eq("model_version", "siglip2-base-patch16-384-v1")
    .eq("crop_type", "full");
  const siglipDistinct = new Set((siglipSlugs ?? []).map(r => r.canonical_slug));
  console.log(`\nDistinct slugs with SigLIP+full coverage: ${siglipDistinct.size}`);

  // Q4: Pricing — does Perfect Order have any price rows?
  // Check public_card_metrics (the prod-facing materialized table)
  const { count: priceCount, error: priceErr } = await sb
    .from("public_card_metrics")
    .select("canonical_slug", { count: "exact", head: true })
    .like("canonical_slug", "perfect-order-%");
  console.log(`\npublic_card_metrics 'perfect-order-%' count: ${priceCount ?? "ERR: " + priceErr?.message}`);

  // Q4b: Of those, how many have non-null market_price?
  const { count: pricedCount } = await sb
    .from("public_card_metrics")
    .select("canonical_slug", { count: "exact", head: true })
    .like("canonical_slug", "perfect-order-%")
    .not("market_price", "is", null);
  console.log(`  ...with non-null market_price: ${pricedCount ?? "ERR"}`);

  // Q4c: Sample some price rows
  const { data: priceSample } = await sb
    .from("public_card_metrics")
    .select("canonical_slug, market_price, market_price_as_of, market_price_source")
    .like("canonical_slug", "perfect-order-%")
    .order("canonical_slug")
    .limit(5);
  console.log("Sample public_card_metrics rows:");
  for (const r of priceSample ?? []) {
    console.log(`  ${r.canonical_slug} | $${r.market_price ?? "NULL"} | as_of=${r.market_price_as_of?.slice(0, 10) ?? "NULL"} | src=${r.market_price_source ?? "NULL"}`);
  }

  // Q5: Compare to a control set (Mega Evolution, fully-covered)
  console.log("\n=== Control: mega-evolution-% ===");
  const { count: meCanonCount } = await sb
    .from("canonical_cards")
    .select("slug", { count: "exact", head: true })
    .like("slug", "mega-evolution-%");
  const { count: meEmbedDistinct } = await sb
    .from("card_image_embeddings")
    .select("canonical_slug", { count: "exact", head: true })
    .like("canonical_slug", "mega-evolution-%")
    .eq("model_version", "siglip2-base-patch16-384-v1")
    .eq("crop_type", "full");
  const { count: mePriceCount } = await sb
    .from("public_card_metrics")
    .select("canonical_slug", { count: "exact", head: true })
    .like("canonical_slug", "mega-evolution-%")
    .not("market_price", "is", null);
  console.log(`  canonical_cards: ${meCanonCount} | siglip+full embeddings: ${meEmbedDistinct} | priced: ${mePriceCount}`);

  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });

import assert from "node:assert/strict";

import { buildCardSeoContent } from "../lib/seo/card-content.ts";
import { cardProductSchema } from "../lib/seo/schema.ts";
import { serializeJsonLd } from "../lib/seo/json-ld-serialize.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function base(overrides = {}) {
  return {
    name: "Umbreon ex",
    setName: "Prismatic Evolutions",
    cardNumber: "161",
    year: 2025,
    rarity: "Special Illustration Rare",
    subject: "Umbreon",
    priceDisplay: { kind: "live", price: 1308, asOf: "2026-06-14T00:00:00Z", ageDays: 1 },
    ...overrides,
  };
}

// ── Honesty gating: which classifications publish a price ────────────────────

// live → price published in copy AND offer
{
  const c = buildCardSeoContent(base());
  assert.equal(c.offerPrice, 1308, "live → offerPrice = market price");
  assert.match(c.introSentence, /Umbreon ex is a Pokémon trading card from the Prismatic Evolutions set \(2025\), card #161\./);
  assert.match(c.introSentence, /\$1,308/, "live → price visible in intro");
  assert.ok(c.faq.length >= 1);
  assert.match(c.faq[0].question, /^How much is Umbreon ex \(Prismatic Evolutions\) worth\?$/);
  assert.match(c.faq[0].answer, /\$1,308/);
}

// abundant (<= $2) → still publishes a price
{
  const c = buildCardSeoContent(
    base({ rarity: "Common", priceDisplay: { kind: "abundant", price: 0.5, asOf: "2026-06-14T00:00:00Z", ageDays: 1, threshold: 2 } }),
  );
  assert.equal(c.offerPrice, 0.5, "abundant → offerPrice present");
  assert.match(c.introSentence, /\$0\.50/);
}

// stale_recent → publishes a price (within 30d)
{
  const c = buildCardSeoContent(
    base({ priceDisplay: { kind: "stale_recent", price: 40, asOf: "2026-06-01T00:00:00Z", ageDays: 14, ageLabel: "Jun 1" } }),
  );
  assert.equal(c.offerPrice, 40, "stale_recent → offerPrice present");
  assert.match(c.introSentence, /most recently traded around \$40/);
}

// stale_old → price shown visibly as "last sold" but NOT emitted as an offer (conservative)
{
  const c = buildCardSeoContent(
    base({ priceDisplay: { kind: "stale_old", price: 50, asOf: "2026-04-01T00:00:00Z", ageDays: 60, ageLabel: "Apr 2026" } }),
  );
  assert.equal(c.offerPrice, null, "stale_old → no published offer");
  assert.match(c.introSentence, /\$50/, "stale_old → last-sold price still visible");
  assert.match(c.introSentence, /sparse/);
}

// no_market → no price claim anywhere
{
  const c = buildCardSeoContent(base({ priceDisplay: { kind: "no_market", asOf: null } }));
  assert.equal(c.offerPrice, null, "no_market → no offer");
  assert.doesNotMatch(c.introSentence, /\$\d/, "no_market → no dollar figure in copy");
  assert.doesNotMatch(c.faq[0].answer, /\$\d/, "no_market → no dollar figure in FAQ");
  assert.match(c.introSentence, /sparse/);
}

// ── FAQ composition gracefully drops missing fields ──────────────────────────

{
  const c = buildCardSeoContent(base({ setName: null, rarity: null }));
  // Only the "how much is it worth" question survives when set + rarity are absent.
  assert.equal(c.faq.length, 1);
  assert.match(c.faq[0].question, /^How much is Umbreon ex worth\?$/);
}

{
  const c = buildCardSeoContent(base());
  assert.equal(c.faq.length, 3, "full data → worth + set + rarity questions");
  assert.match(c.faq[2].answer, /rarity of "Special Illustration Rare"/);
}

// ── Product schema honesty + shape ───────────────────────────────────────────

// offerPrice null → omit the whole Product block (Google requires offers/review/rating)
{
  const s = cardProductSchema({
    name: "X", slug: "x", description: "d", imageUrl: null,
    setName: "S", cardNumber: "1", rarity: "Common", year: 2024, offerPrice: null,
  });
  assert.equal(s, null, "no publishable offer → cardProductSchema returns null");
}

// offerPrice present → AggregateOffer in USD, rounded to 2dp; valid http image kept
{
  const s = cardProductSchema({
    name: "X", slug: "x y", description: "d", imageUrl: "https://img.example/x.png",
    setName: "S", cardNumber: "1", rarity: "Common", year: 2024, offerPrice: 12.345,
  });
  assert.equal(s.offers["@type"], "AggregateOffer");
  assert.equal(s.offers.priceCurrency, "USD");
  assert.equal(s.offers.lowPrice, 12.35, "price rounded to 2dp");
  assert.equal(s.offers.highPrice, 12.35);
  assert.equal(s.image, "https://img.example/x.png");
  assert.match(s.url, /\/c\/x%20y$/, "slug is URL-encoded in canonical url");
}

// non-http image (e.g. data: / relative) is dropped
{
  const s = cardProductSchema({
    name: "X", slug: "x", description: "d", imageUrl: "/local/x.png",
    setName: null, cardNumber: null, rarity: null, year: null, offerPrice: 5,
  });
  assert.equal(s.image, undefined, "non-http image dropped");
  assert.equal(s.additionalProperty, undefined, "all-null properties → omit additionalProperty");
}

// ── Price formatting matches the page headline (cents below $1000) ───────────
// Guards against the visible prose disagreeing with the hero price + the exact
// AggregateOffer, and against half-up inflation ($250.99 must not read "$251").
{
  const c = buildCardSeoContent(
    base({ priceDisplay: { kind: "live", price: 250.99, asOf: "2026-06-14T00:00:00Z", ageDays: 1 } }),
  );
  assert.equal(c.offerPrice, 250.99, "offer keeps exact cents");
  assert.match(c.introSentence, /\$250\.99/, "sub-$1000 prose shows cents (matches headline + offer)");
  assert.doesNotMatch(c.introSentence, /\$251\b/, "no half-up inflation in prose");
}
{
  // >= $1000 drops cents in prose (mirrors the headline) but offer stays exact.
  const c = buildCardSeoContent(
    base({ priceDisplay: { kind: "live", price: 1308.49, asOf: "2026-06-14T00:00:00Z", ageDays: 1 } }),
  );
  assert.match(c.introSentence, /\$1,308\b/, ">= $1000 prose drops cents");
  assert.equal(c.offerPrice, 1308.49, "offer keeps exact value");
}

// ── JSON-LD is escaped so catalog text can't break out of the <script> tag ───
{
  const html = serializeJsonLd({
    name: 'Card </script><script>alert(1)</script>',
    note: "a < b & c > d",
  });
  assert.doesNotMatch(html, /<\/script>/i, "no literal </script> in serialized JSON-LD");
  assert.doesNotMatch(html, /</, "no literal < in output");
  assert.doesNotMatch(html, />/, "no literal > in output");
  // Escaping is lossless: parses back to the identical data.
  const parsed = JSON.parse(html);
  assert.equal(parsed.name, 'Card </script><script>alert(1)</script>');
  assert.equal(parsed.note, "a < b & c > d");
}

console.log("seo-card-content tests passed");

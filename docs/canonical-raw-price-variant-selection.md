# Canonical RAW price — variant selection & failure modes

How PopAlpha picks the ONE ungraded price it shows for a canonical card (the
hero / chart / 24h-7d change), and the two failure modes the 2026-05-31
variant-alignment investigation surfaced. Distinct from
`card-detail-variant-picker.md` (that's the *UI* variant selector; this is the
*backend* price the headline derives from).

## How the price's variant is chosen

A canonical card (e.g. `skyridge-1-aerodactyl`) maps to multiple
`card_printings` (finishes: NON_HOLO / HOLO / REVERSE_HOLO / ALT_HOLO; plus
edition / stamp), each with its own market price. The displayed RAW price comes
from **one** of them, chosen in `refresh_price_changes_core` (latest body:
`supabase/migrations/20260531140000_*`):

1. `preferred_canonical_raw_printing(slug)` (`20260309230000_prefer_base_printing_for_canonical_raw.sql`)
   picks the **printing** — ORDER BY: EN first → edition (UNLIMITED<UNKNOWN<else)
   → unstamped<stamped → **finish NON_HOLO(0) < HOLO(1) < REVERSE_HOLO(2) <
   ALT_HOLO(3)** → updated_at. So it prefers the base/normal print. It is NOT
   liquidity/volume-aware.
2. `base_points` filters `price_history_points` to that printing (by
   `split_part(variant_ref,'::',1)`) **and to ungraded only**
   (`split_part(variant_ref,'::',3)='RAW'` — see Failure mode A).
3. `provider_variant_match_score` (`20260309234500_*`) ranks the surviving
   variant_refs against the preferred finish/edition/stamp; ties break on
   recency → price-proximity to `current_scrydex_price` → source_priority.
4. The hero = a rolling **3-day median** of that one variant's daily series
   (chart-series-truth, `#147`); the 24h/7d change is median-vs-median.

`public_card_metrics` reads these as the EN-RAW `market_price` / `change_pct_*`,
COALESCEing to the prior basis when there's no ungraded series.

### `variant_ref` format (price_history_points)
- Ungraded: `<printing_id>::<scrydex_variant>::RAW` → `split_part(...,'::',3)='RAW'`
- Graded: `<printing_id>::<scrydex_variant>::GRADED::<company>::<grade>::RAW` → seg3=`'GRADED'`
- `seg1` = printing id. **Discriminator is seg3, not the `::RAW` suffix** (graded refs also end in `::RAW`).

## Failure mode A — graded leak into the RAW headline (FIXED, #149)

`base_points` originally filtered by printing-id only, NOT by grade. Because the
match score ties graded with ungraded, cards whose preferred printing had only
graded snapshots in-window (or where a graded ref won the price-proximity
tiebreak) showed a **graded price as the RAW hero** — ~357 cards had a
graded-derived `display_price`, ~58 surfaced (e.g. `aquapolis-116-vulpix`
$83.56→$8.34, `crystal-guardians-57-mudkip` $34.92→$2.87,
`brilliant-stars-174-charizard-vstar` $241.62→$75). This row is `grade='RAW'`,
so graded never belongs.

**Fix (`20260531140000`):** `base_points` requires
`split_part(variant_ref,'::',3) = 'RAW'`. Don't remove it. Cards with no
ungraded series get a null `display_price` and fall back to the prior raw basis.

**Detection query** (should return 0):
```sql
-- EN-RAW cards whose display_price exists but has no ungraded series = graded leak
with pref as (select cc.slug, public.preferred_canonical_raw_printing(cc.slug) pid
              from canonical_cards cc where cc.language='EN'),
ungraded as (select ph.canonical_slug from price_history_points ph
  join pref on pref.slug=ph.canonical_slug and pref.pid is not null
  where ph.provider in ('SCRYDEX','POKEMON_TCG_API') and ph.source_window in ('snapshot','7d','30d')
    and split_part(ph.variant_ref,'::',1)=pref.pid::text and split_part(ph.variant_ref,'::',3)='RAW'
    and ph.ts > now()-interval '3 days' group by 1)
select count(*) from card_metrics cm left join ungraded u using (canonical_slug)
where cm.printing_id is null and cm.grade='RAW' and cm.display_price is not null and u.canonical_slug is null;
```

## Failure mode B — finish-rank ≠ collector expectation (KNOWN, deferred)

The picker is finish-ranked, not popularity/liquidity-ranked, and there's no
cross-check against the variant PriceCharting prices. So when a card's famous
version is the holo/reverse but a NON_HOLO printing also exists, the headline
tracks the NON_HOLO price. For `skyridge-1-aerodactyl` it picks NON_HOLO
(~$199.95); the reverse-holo (~$1,159.80) is a different printing (correctly
excluded), and PriceCharting prices the card at ~$41 — three unaligned numbers.

This is sound for the common "normal print is canonical" case (98% of cards
match the clean ungraded median) but can misalign on holo-canonical / chase
cards. **No clean fix without per-finish liquidity/popularity data** (a future
improvement: rank the preferred printing by traded volume, or surface the finish
on the headline). Deferred.

**Corollary — don't promote PriceCharting to a price *source*.** The ~342
PriceCharting-vs-Scrydex "divergences" (median 73–91% apart) are largely this
variant misalignment: PriceCharting prices a different finish/condition basis
than the NON_HOLO Scrydex variant we pick. So PriceCharting-as-source ("PR B")
is unreliable and was intentionally NOT built. PriceCharting stays a private
trust guardrail only.

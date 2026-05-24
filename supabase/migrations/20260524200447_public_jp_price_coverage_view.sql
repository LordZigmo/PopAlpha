-- Public JP price coverage view.
--
-- public_card_metrics intentionally starts from card_metrics, so JP cards
-- with a fresh Yahoo! JP or Snkrdunk source price but no current metrics row
-- remain invisible to homepage/search-style readers. This view starts from
-- canonical JP cards instead, then left-joins the guarded public metrics row
-- and the private JP companion price tables. It exposes only the fields a
-- public reader needs to answer: "is this JP card covered by a trusted price,
-- which source is it, and how fresh is it?"
--
-- Trust contract:
--   * canonical RAW only (printing_id is null, grade = RAW)
--   * JP-native display source requires sample_count >= 3
--   * source-pick mirrors lib/pricing/jp-price-source.ts:
--       - if both Yahoo! JP and Snkrdunk qualify, pick the larger sample count
--       - ties go to Yahoo! JP
--       - otherwise fall back to the guarded market_price
--   * no direct public access to yahoo_jp_card_prices or snkrdunk_card_prices

create or replace view public.public_jp_price_coverage as
with base as (
  select
    cc.slug as canonical_slug,
    cc.canonical_name,
    cc.set_name,
    cc.year,
    cc.card_number,
    cc.primary_image_url,
    cc.mirrored_primary_image_url,
    cc.mirrored_primary_thumb_url,
    'RAW'::text as grade,
    pcm.market_price,
    pcm.market_price_as_of,
    pcm.market_confidence_score,
    pcm.market_low_confidence,
    pcm.active_listings_7d,
    pcm.snapshot_count_30d,
    pcm.change_pct_24h,
    pcm.change_pct_7d,
    yjp.price_usd as yahoo_jp_price,
    yjp.price_jpy as yahoo_jp_price_jpy,
    yjp.sample_count as yahoo_jp_sample_count,
    yjp.observed_at as yahoo_jp_observed_at,
    snk.price_usd as snkrdunk_price,
    snk.price_jpy as snkrdunk_price_jpy,
    snk.sample_count as snkrdunk_sample_count,
    snk.observed_at as snkrdunk_observed_at,
    snk.snkrdunk_product_code
  from public.canonical_cards cc
  left join public.public_card_metrics pcm
    on pcm.canonical_slug = cc.slug
   and pcm.printing_id is null
   and pcm.grade = 'RAW'
  left join public.yahoo_jp_card_prices yjp
    on yjp.canonical_slug = cc.slug
   and yjp.printing_id is null
   and yjp.grade = 'RAW'
  left join public.snkrdunk_card_prices snk
    on snk.canonical_slug = cc.slug
   and snk.printing_id is null
   and snk.grade = 'RAW'
  where cc.language = 'JP'
),
qualified as (
  select
    base.*,
    (
      base.market_price is not null
      and base.market_price > 0
    ) as has_market_price,
    (
      base.yahoo_jp_price is not null
      and base.yahoo_jp_price > 0
      and coalesce(base.yahoo_jp_sample_count, 0) >= 3
    ) as yahoo_jp_qualified,
    (
      base.snkrdunk_price is not null
      and base.snkrdunk_price > 0
      and coalesce(base.snkrdunk_sample_count, 0) >= 3
    ) as snkrdunk_qualified
  from base
),
picked as (
  select
    qualified.*,
    case
      when qualified.snkrdunk_qualified
       and (
         not qualified.yahoo_jp_qualified
         or coalesce(qualified.snkrdunk_sample_count, 0) > coalesce(qualified.yahoo_jp_sample_count, 0)
       )
      then 'snkrdunk'
      when qualified.yahoo_jp_qualified then 'yahoo_jp'
      else null
    end as picked_jp_source
  from qualified
)
select
  picked.canonical_slug,
  picked.canonical_name,
  picked.set_name,
  picked.year,
  picked.card_number,
  picked.primary_image_url,
  picked.mirrored_primary_image_url,
  picked.mirrored_primary_thumb_url,
  picked.grade,
  picked.market_price,
  picked.market_price_as_of,
  picked.market_confidence_score,
  picked.market_low_confidence,
  picked.active_listings_7d,
  picked.snapshot_count_30d,
  picked.change_pct_24h,
  picked.change_pct_7d,
  picked.yahoo_jp_price,
  picked.yahoo_jp_price_jpy,
  picked.yahoo_jp_sample_count,
  picked.yahoo_jp_observed_at,
  picked.snkrdunk_price,
  picked.snkrdunk_price_jpy,
  picked.snkrdunk_sample_count,
  picked.snkrdunk_observed_at,
  picked.snkrdunk_product_code,
  picked.has_market_price,
  picked.yahoo_jp_qualified,
  picked.snkrdunk_qualified,
  (picked.yahoo_jp_qualified or picked.snkrdunk_qualified) as has_qualified_jp_source_price,
  case
    when picked.picked_jp_source is not null then picked.picked_jp_source
    when picked.has_market_price then 'market'
    else null
  end as display_price_source,
  case
    when picked.picked_jp_source = 'snkrdunk' then picked.snkrdunk_price
    when picked.picked_jp_source = 'yahoo_jp' then picked.yahoo_jp_price
    when picked.has_market_price then picked.market_price
    else null
  end as display_price_usd,
  case
    when picked.picked_jp_source = 'snkrdunk' then picked.snkrdunk_price_jpy
    when picked.picked_jp_source = 'yahoo_jp' then picked.yahoo_jp_price_jpy
    else null
  end as display_price_jpy,
  case
    when picked.picked_jp_source = 'snkrdunk' then picked.snkrdunk_sample_count
    when picked.picked_jp_source = 'yahoo_jp' then picked.yahoo_jp_sample_count
    when picked.has_market_price then picked.snapshot_count_30d
    else null
  end as display_price_sample_count,
  case
    when picked.picked_jp_source = 'snkrdunk' then picked.snkrdunk_observed_at
    when picked.picked_jp_source = 'yahoo_jp' then picked.yahoo_jp_observed_at
    when picked.has_market_price then picked.market_price_as_of
    else null
  end as display_price_as_of,
  (
    picked.has_market_price
    or picked.yahoo_jp_qualified
    or picked.snkrdunk_qualified
  ) as covered_by_price
from picked;

grant select on public.public_jp_price_coverage to anon, authenticated;

comment on view public.public_jp_price_coverage is
  'Public read view for JP card price coverage. Starts from JP canonical_cards '
  'and exposes a trusted display price from Yahoo! JP, Snkrdunk, or the guarded '
  'public_card_metrics market price without granting direct access to private '
  'JP companion price tables.';

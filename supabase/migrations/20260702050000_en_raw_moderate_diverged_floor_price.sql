-- 20260702050000_en_raw_moderate_diverged_floor_price.sql
--
-- supersedes: 20260620120000_en_raw_cheap_diverged_floor_price.sql
--             (public_card_metrics — the view's latest prior definer. The
--              fnbody guard only inspects functions, but the same latest-body
--              discipline applies to views. Body reproduced VERBATIM below.
--              Declared changes ONLY: (1) one computed boolean
--              `moderate_diverged_floor` added to joined_rows alongside
--              cheap_diverged_floor; (2) a single new WHEN branch keyed on
--              that flag added immediately AFTER the existing
--              cheap_diverged_floor branch (and ahead of the
--              DIVERGED-suppression branch) in each of the EN-RAW
--              price / price_as_of / provider_compare_as_of / latest_price /
--              latest_price_as_of / change_24h / change_7d / confidence /
--              blend_policy CASEs, the market_price_display_state CASE, and
--              the provenance confidenceStatus / publicInputStatus /
--              quarantineReason / sourceMix.scrydexWeight CASEs. The
--              public_low_confidence CASE intentionally gets NO branch —
--              moderate rows fall through to the EN-RAW `else true`. No
--              column added, dropped, reordered or repurposed in the final
--              SELECT — this migration redefines the VIEW only.)
--
-- PROBLEM
-- -------
-- The cheap-diverged floor (20260620120000) only rescues DIVERGED EN-RAW rows
-- where BOTH sources sit at <= $2. A DIVERGED card above that band still
-- hard-nulls even when the two sources disagree only MODERATELY — e.g.
-- chaos-rising-104-mega-dragalge-ex (user report 2026-07-01): Scrydex $4.42
-- vs PriceCharting $6.32, relative_delta_pct 35.4 — a hair over the 35% MATCH
-- threshold, on a freshly released set where PriceCharting has 6 observations
-- and price discovery is still settling. The result is a blank hero on a
-- non-trivial card for weeks after a set drops, which erodes trust from the
-- opposite direction ("the app has no prices for new cards") and blocks
-- marketing content that needs a visible price.
--
-- FIX (approved product decision, 2026-07-01)
-- -------------------------------------------
-- For DIVERGED EN-RAW rows above the cheap band (greatest(source) > $2) whose
-- stored relative_delta_pct — the SAME |delta| / midpoint metric the
-- canonical_trusted_raw_prices classifier uses, so view and classifier cannot
-- drift — is <= 60, surface the conservative LOWER of the two sources
-- (least(...)) instead of nulling. Never overstates: the shown figure is the
-- one both sources would price at or above. Wild disagreements (> 60% — the
-- Latias $564-on-$5 class) stay hard-suppressed with the iOS diverged note.
-- Surfaced rows are de-rated harder than any other shown price: confidence 20
-- (below the cheap floor's 25 — real dollars are at stake and the sources
-- actively disagree), market_low_confidence true, NO change badge, blend
-- policy POPALPHA_MARKET_MODERATE_DIVERGED_FLOOR, display state
-- PRICECHARTING_MODERATE_DIVERGED, and the provenance reports a shown
-- low-confidence price (confidenceStatus LOW, publicInputStatus SUPPORTED, no
-- quarantineReason) while still honestly flagging the underlying divergence
-- (priceConflictStatus INTERNAL_GUARDRAIL_DIVERGED, internalGuardrailStatus
-- DIVERGED). Excludes raw_market_price_outlier rows, matching the cheap
-- branch. relative_delta_pct is null-guarded: rows without a stored delta
-- (stale classifier run) stay suppressed.
--
-- CLIENT IMPACT: none required. iOS shows market_price as the hero (the
-- diverged note keys on blend policy POPALPHA_MARKET_QUARANTINED AND a blank
-- hero, so it auto-hides); market_blend_policy decodes as a plain String.
-- Web: lib/data/market.ts string unions gain the two new values in the same
-- PR (unknown values already normalize safely). Pure backend view
-- redefinition — no data backfill, takes effect on the next query.

create or replace view public.public_card_metrics as
with metric_rows as (
  select
    base_cm.*,
    (
      base_cm.grade = 'RAW'
      and base_cm.market_price is not null
      and coalesce(base_cm.snapshot_count_30d, 0) >= 5
      and base_cm.market_price > (
        greatest(
          coalesce(nullif(base_cm.median_7d, 0), 0),
          coalesce(nullif(base_cm.median_30d, 0), 0),
          coalesce(nullif(base_cm.trimmed_median_30d, 0), 0),
          coalesce(nullif(base_cm.low_30d, 0), 0),
          1
        ) * 20
      )
    ) as raw_market_price_outlier
  from public.card_metrics base_cm
),
joined_rows as (
  select
    cm.*,
    cc.canonical_name_native,
    cc.set_name_native,
    cc.language as canonical_language,
    (cc.language = 'EN' and cm.grade = 'RAW') as is_en_raw,
    ctrp.trust_status as private_trust_status,
    ctrp.trusted_price_usd as private_trusted_price_usd,
    ctrp.trusted_price_as_of as private_trusted_price_as_of,
    ctrp.trusted_price_source as private_trusted_price_source,
    ctrp.pricecharting_price_usd as private_guardrail_price_usd,
    ctrp.pricecharting_as_of as private_guardrail_as_of,
    ctrp.scrydex_price_usd as private_scrydex_price_usd,
    ctrp.scrydex_as_of as private_scrydex_as_of,
    ctrp.quarantine_reason as private_quarantine_reason,
    ctrp.pricecharting_change_pct_24h as private_pricecharting_change_pct_24h,
    ctrp.pricecharting_change_pct_7d as private_pricecharting_change_pct_7d,
    -- Sample-count gate for the single-source PriceCharting display branch.
    coalesce(ctrp.pricecharting_observations_7d, 0) as private_pricecharting_observations_7d,
    -- NEW (20260620120000): cheap diverged floor. True for an EN-RAW DIVERGED
    -- row where BOTH sources are present, positive, and the HIGHER of the two
    -- is <= $2 (a genuinely low-dollar card the sources only disagree on by
    -- pennies-to-a-dollar) and the row is not a Scrydex-basis outlier. Defined
    -- once here and referenced by every downstream CASE so the surfaced-floor
    -- treatment can't drift between price, badge, confidence and provenance.
    (
      ctrp.trust_status = 'PRICECHARTING_DIVERGED'
      and ctrp.scrydex_price_usd is not null and ctrp.scrydex_price_usd > 0
      and ctrp.pricecharting_price_usd is not null and ctrp.pricecharting_price_usd > 0
      and greatest(ctrp.scrydex_price_usd, ctrp.pricecharting_price_usd) <= 2
      and not coalesce(cm.raw_market_price_outlier, false)
    ) as cheap_diverged_floor,
    -- NEW (20260702050000): moderate diverged floor. True for an EN-RAW
    -- DIVERGED row ABOVE the cheap band (> $2) where the stored
    -- relative_delta_pct — the same |delta| / midpoint metric the
    -- canonical_trusted_raw_prices classifier gates MATCH on at 35 — is <= 60.
    -- The two sources disagree, but only moderately (common during price
    -- discovery on freshly released sets); we surface the conservative LOWER
    -- of the two rather than a blank hero. Wild disagreements (> 60) and
    -- rows with no stored delta stay suppressed. Defined once here and
    -- referenced by every downstream CASE, mirroring cheap_diverged_floor.
    (
      ctrp.trust_status = 'PRICECHARTING_DIVERGED'
      and ctrp.scrydex_price_usd is not null and ctrp.scrydex_price_usd > 0
      and ctrp.pricecharting_price_usd is not null and ctrp.pricecharting_price_usd > 0
      and greatest(ctrp.scrydex_price_usd, ctrp.pricecharting_price_usd) > 2
      and ctrp.relative_delta_pct is not null
      and ctrp.relative_delta_pct <= 60
      and not coalesce(cm.raw_market_price_outlier, false)
    ) as moderate_diverged_floor,
    coalesce(yjp_specific.price_usd, yjp_canonical.price_usd) as yahoo_jp_price_out,
    coalesce(yjp_specific.price_jpy, yjp_canonical.price_jpy) as yahoo_jp_price_jpy_out,
    coalesce(yjp_specific.sample_count, yjp_canonical.sample_count) as yahoo_jp_sample_count_out,
    coalesce(yjp_specific.observed_at, yjp_canonical.observed_at) as yahoo_jp_observed_at_out,
    coalesce(snk_specific.price_usd, snk_canonical.price_usd) as snkrdunk_price_out,
    coalesce(snk_specific.sample_count, snk_canonical.sample_count) as snkrdunk_sample_count_out,
    coalesce(snk_specific.observed_at, snk_canonical.observed_at) as snkrdunk_observed_at_out,
    coalesce(snk_specific.snkrdunk_product_code, snk_canonical.snkrdunk_product_code) as snkrdunk_product_code_out,
    coalesce(snk_specific.price_jpy, snk_canonical.price_jpy) as snkrdunk_price_jpy_out
  from metric_rows cm
  left join public.yahoo_jp_card_prices yjp_specific
    on yjp_specific.canonical_slug = cm.canonical_slug
   and yjp_specific.printing_id = cm.printing_id
   and yjp_specific.grade = cm.grade
  left join public.yahoo_jp_card_prices yjp_canonical
    on yjp_canonical.canonical_slug = cm.canonical_slug
   and yjp_canonical.printing_id is null
   and yjp_canonical.grade = cm.grade
  left join public.snkrdunk_card_prices snk_specific
    on snk_specific.canonical_slug = cm.canonical_slug
   and snk_specific.printing_id = cm.printing_id
   and snk_specific.grade = cm.grade
  left join public.snkrdunk_card_prices snk_canonical
    on snk_canonical.canonical_slug = cm.canonical_slug
   and snk_canonical.printing_id is null
   and snk_canonical.grade = cm.grade
  left join public.canonical_cards cc
    on cc.slug = cm.canonical_slug
  left join public.canonical_trusted_raw_prices ctrp
    on ctrp.canonical_slug = cm.canonical_slug
   and ctrp.printing_id is not distinct from cm.printing_id
),
public_price_policy as (
  select
    j.*,
    case
      when j.is_en_raw then
        -- Chart-series-truth: EN-RAW headline derives from the Scrydex daily
        -- snapshot median (display_price), the same series the chart plots.
        -- COALESCE to the prior basis when no snapshot series exists (chart is
        -- then sparse/empty too, so nothing to be inconsistent with). All
        -- suppression branches below still hard-null exactly as before.
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.display_price, j.private_trusted_price_usd)
          -- Well-sampled single-source PriceCharting: surface the PriceCharting
          -- price (mirrors the MATCH branch's source — for PRIMARY rows
          -- private_trusted_price_usd IS the PriceCharting price). Labeled
          -- low-confidence downstream. Thin PRIMARY still hard-nulls.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
            then coalesce(j.display_price, j.private_trusted_price_usd)
          -- Cheap diverged floor: both sources agree the card is low-dollar
          -- (higher of the two <= $2) but disagree on the exact pennies. The
          -- exact figure barely matters at this price, so surface the
          -- conservative LOWER of the two instead of suppressing. De-rated and
          -- badge-suppressed downstream. MUST precede the DIVERGED hard-null.
          when j.cheap_diverged_floor
            then least(j.private_scrydex_price_usd, j.private_guardrail_price_usd)
          -- Moderate diverged floor: sources disagree by <= 60% (midpoint
          -- basis) on a > $2 card — surface the conservative LOWER of the
          -- two. De-rated and badge-suppressed downstream. MUST precede the
          -- DIVERGED hard-null.
          when j.moderate_diverged_floor
            then least(j.private_scrydex_price_usd, j.private_guardrail_price_usd)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.display_price, j.private_scrydex_price_usd, j.market_price)
          else coalesce(j.display_price, j.market_price)
        end
      -- Graded (grade <> 'RAW'): the 14-day median display price (freshest+median
      -- redesign). Graded market_price is always NULL today, so this is purely
      -- additive — coalesce only ever resolves to display_price.
      when j.grade <> 'RAW' then coalesce(j.display_price, j.market_price)
      -- JP RAW: the base market_price is SCRYDEX_PRIMARY (a thin/wrong US-market
      -- price for JP cards). Use the JP-native 14-day median instead; NULL when
      -- there's no qualifying JP series (honest, not the Scrydex garbage).
      when j.canonical_language = 'JP' and j.grade = 'RAW' then j.jp_display_price
      when j.raw_market_price_outlier then null
      else j.market_price
    end as public_market_price,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                 end
          -- Single-source PriceCharting as_of mirrors the MATCH branch: the
          -- display series' as_of when display_price drove the headline, else
          -- the PriceCharting (trusted) as_of.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                 end
          -- Cheap diverged floor: the as_of of whichever source supplied the
          -- shown (lower) price.
          when j.cheap_diverged_floor
            then case
                   when j.private_scrydex_price_usd <= j.private_guardrail_price_usd
                     then coalesce(j.private_scrydex_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                   else coalesce(j.private_guardrail_as_of, j.private_scrydex_as_of, j.market_price_as_of)
                 end
          -- Moderate diverged floor: the as_of of whichever source supplied
          -- the shown (lower) price — mirrors the cheap branch above.
          when j.moderate_diverged_floor
            then case
                   when j.private_scrydex_price_usd <= j.private_guardrail_price_usd
                     then coalesce(j.private_scrydex_as_of, j.private_guardrail_as_of, j.market_price_as_of)
                   else coalesce(j.private_guardrail_as_of, j.private_scrydex_as_of, j.market_price_as_of)
                 end
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then case
                   when j.display_price is not null then j.display_price_as_of
                   else coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.market_price_as_of)
                 end
          else case
                 when j.display_price is not null then j.display_price_as_of
                 else j.market_price_as_of
               end
        end
      when j.grade <> 'RAW' then
        case when j.display_price is not null then j.display_price_as_of else j.market_price_as_of end
      when j.canonical_language = 'JP' and j.grade = 'RAW' then j.jp_display_price_as_of
      when j.raw_market_price_outlier then null
      else j.market_price_as_of
    end as public_market_price_as_of,
    case
      when j.is_en_raw then
        case
          when j.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(j.private_scrydex_as_of, j.provider_compare_as_of)
          -- Single-source PriceCharting has no Scrydex provider to compare
          -- against; fall back to the PriceCharting (trusted) as_of so the
          -- provider-compare timestamp isn't blanked while the price shows.
          when j.private_trust_status = 'PRICECHARTING_PRIMARY'
           and j.private_pricecharting_observations_7d >= 5
           and not coalesce(j.raw_market_price_outlier, false)
            then coalesce(j.private_trusted_price_as_of, j.private_guardrail_as_of, j.provider_compare_as_of)
          -- Cheap diverged floor: both providers are present, so the
          -- provider-compare timestamp is meaningful.
          when j.cheap_diverged_floor
            then coalesce(j.private_scrydex_as_of, j.private_guardrail_as_of, j.provider_compare_as_of)
          -- Moderate diverged floor: both providers are present, so the
          -- provider-compare timestamp is meaningful (cheap-branch mirror).
          when j.moderate_diverged_floor
            then coalesce(j.private_scrydex_as_of, j.private_guardrail_as_of, j.provider_compare_as_of)
          when j.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then null
          when j.raw_market_price_outlier
            then null
          when j.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
            then coalesce(j.private_scrydex_as_of, j.private_trusted_price_as_of, j.provider_compare_as_of)
          else j.provider_compare_as_of
        end
      when j.raw_market_price_outlier then null
      else j.provider_compare_as_of
    end as public_provider_compare_as_of
  from joined_rows j
),
public_signal_policy as (
  select
    p.*,
    -- Freshest hero price. Same suppression as the headline (null when the
    -- median headline is hidden). For EN-RAW: the freshest daily snapshot point,
    -- falling back to the median basis so the hero never blanks. For JP / graded
    -- (non-EN-RAW): mirror the headline price — their hero comes from JP-native /
    -- graded sources, not the Scrydex snapshot the latest_price column holds, so
    -- never surface a snapshot-derived freshest here (a later step wires their
    -- own freshest+median). One value per spot, never a competing basis.
    case
      when p.public_market_price is null then null
      -- Cheap diverged floor: the freshest snapshot (p.latest_price) is the
      -- Scrydex daily point, which when PriceCharting is the LOWER source is
      -- NOT the floor we surfaced. Clients (iOS CardDetailView, web market
      -- pulse) prefer latest_price over market_price for the hero, so pin
      -- latest to the floor here or they'd render the higher source. MUST
      -- precede the generic EN-RAW latest fallback.
      when p.is_en_raw and p.cheap_diverged_floor then p.public_market_price
      -- Moderate diverged floor: same latest-price pin as the cheap branch —
      -- the freshest Scrydex snapshot is NOT necessarily the floor we
      -- surfaced, so pin the hero to the floor.
      when p.is_en_raw and p.moderate_diverged_floor then p.public_market_price
      when p.is_en_raw then coalesce(p.latest_price, p.public_market_price)
      -- Graded hero = freshest sold point, falling back to the 14d-median headline.
      when p.grade <> 'RAW' then coalesce(p.latest_price, p.public_market_price)
      when p.canonical_language = 'JP' and p.grade = 'RAW' then coalesce(p.jp_latest_price, p.public_market_price)
      else p.public_market_price
    end as public_latest_price,
    case
      when p.public_market_price is null then null
      -- Cheap diverged floor: as_of of the surfaced floor, matching the price above.
      when p.is_en_raw and p.cheap_diverged_floor then p.public_market_price_as_of
      -- Moderate diverged floor: as_of of the surfaced floor (cheap mirror).
      when p.is_en_raw and p.moderate_diverged_floor then p.public_market_price_as_of
      when p.is_en_raw then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      when p.grade <> 'RAW' then coalesce(p.latest_price_as_of, p.public_market_price_as_of)
      when p.canonical_language = 'JP' and p.grade = 'RAW' then coalesce(p.jp_latest_price_as_of, p.public_market_price_as_of)
      else p.public_market_price_as_of
    end as public_latest_price_as_of,
    case
      when p.is_en_raw then
        -- Median-basis change so the hero and the change % are coherent. Use
        -- the display change when the headline itself came from display_price;
        -- otherwise fall back to the prior change basis under the same guard.
        case
          when p.public_market_price is null then null
          -- Cheap diverged floor: deliberately NO change badge — the two
          -- sources disagree, so we make no movement claim. MUST run before the
          -- display-change fallback (the surfaced headline is now non-null, so a
          -- stray display_change_pct_24h would otherwise leak a movement %).
          when p.cheap_diverged_floor then null
          -- Moderate diverged floor: NO change badge either — same reasoning,
          -- same ordering constraint as the cheap branch above.
          when p.moderate_diverged_floor then null
          -- Single-source PriceCharting: deliberately NO change badge. MUST run
          -- before the display-change fallback — the single-source headline is now
          -- non-null, so a stray display_change_pct_24h would otherwise leak a
          -- movement % onto a low-confidence single-source price.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
            then null
          when p.display_price is not null and p.display_change_pct_24h is not null
            then p.display_change_pct_24h
          -- Price-corroborated (MATCH) cards: prefer the Scrydex-derived change;
          -- fall back to PopAlpha's PriceCharting-derived change (outlier-capped
          -- at |%| <= 200, matching the Scrydex path) when Scrydex's is absent.
          -- Both are our own computations; the two-source price corroboration is
          -- what keeps it trustworthy. Non-MATCH stays null (conservative).
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(
              p.change_pct_24h,
              case when abs(p.private_pricecharting_change_pct_24h) <= 200
                     and p.private_guardrail_as_of >= now() - interval '48 hours'
                   then p.private_pricecharting_change_pct_24h else null end
            )
          -- Everything else (non-MATCH corroborated paths) stays null — conservative.
          -- Single-source is already nulled above, ahead of the display fallback.
          else null
        end
      -- Thin-tier JP rows (max in-window sample_count < 3): deliberately NO
      -- change badge. MUST run before the display-change fallback below —
      -- jp_display_change_pct_* is already NULL for thin rows (the function
      -- computes deltas from the trusted series only), but the base
      -- change_pct_24h fallback could carry a STALE delta written while the
      -- card still had a trusted series, leaking a movement % onto a
      -- low-confidence thin-sample price (the EN single-source ordering
      -- note, JP edition).
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then null
      -- JP RAW: display-basis change. refresh_jp_price_display derives these
      -- from the SAME blended daily series that produces the jp_display_price
      -- headline above, so the badge basis matches the price basis exactly
      -- (EN's display_change parity, JP edition). Sits BEFORE the outlier
      -- guard for the same reason the JP price branch does: the outlier flag
      -- is about the Scrydex-basis base market_price, which the JP display
      -- path never uses. The fallback preserves the prior passthrough EXACTLY
      -- (outlier -> null, else the base change from
      -- compute_jp_card_price_changes) for series too sparse for a
      -- display-basis delta.
      when p.canonical_language = 'JP' and p.grade = 'RAW' then
        coalesce(
          p.jp_display_change_pct_24h,
          case when p.raw_market_price_outlier then null else p.change_pct_24h end
        )
      when p.raw_market_price_outlier then null
      else p.change_pct_24h
    end as public_change_pct_24h,
    case
      when p.is_en_raw then
        case
          when p.public_market_price is null then null
          -- Cheap diverged floor: no change badge (see 24h note) — guard runs
          -- before the display-change fallback.
          when p.cheap_diverged_floor then null
          -- Moderate diverged floor: no change badge (see 24h note).
          when p.moderate_diverged_floor then null
          -- Single-source PriceCharting: no change badge (see 24h note) — guard runs
          -- before the display-change fallback.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
            then null
          when p.display_price is not null and p.display_change_pct_7d is not null
            then p.display_change_pct_7d
          -- Price-corroborated (MATCH) cards: prefer the Scrydex-derived change;
          -- fall back to PopAlpha's PriceCharting-derived change (outlier-capped
          -- at |%| <= 200, matching the Scrydex path) when Scrydex's is absent.
          -- Both are our own computations; the two-source price corroboration is
          -- what keeps it trustworthy. Non-MATCH stays null (conservative).
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
            then coalesce(
              p.change_pct_7d,
              case when abs(p.private_pricecharting_change_pct_7d) <= 200
                     and p.private_guardrail_as_of >= now() - interval '48 hours'
                   then p.private_pricecharting_change_pct_7d else null end
            )
          -- Everything else stays null (single-source nulled above).
          else null
        end
      -- Thin-tier JP rows: no change badge — see the 24h note above; same
      -- ordering, ahead of the display-change fallback.
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then null
      -- JP RAW: display-basis change — see the 24h note above.
      when p.canonical_language = 'JP' and p.grade = 'RAW' then
        coalesce(
          p.jp_display_change_pct_7d,
          case when p.raw_market_price_outlier then null else p.change_pct_7d end
        )
      when p.raw_market_price_outlier then null
      else p.change_pct_7d
    end as public_change_pct_7d,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 90
          -- Well-sampled single-source PriceCharting: low confidence (30). The
          -- price is surfaced but explicitly de-rated vs the 90 of a
          -- two-source MATCH and the 35 cap of a public-input low-confidence row.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then 30
          -- Cheap diverged floor: lowest surfaced confidence (25). Below the 30
          -- of a single-source headline because the two sources actively
          -- disagree — we show the floor only because the dollar stakes are
          -- trivial, not because we trust the figure.
          when p.cheap_diverged_floor and p.public_market_price is not null
            then 25
          -- Moderate diverged floor: lowest surfaced confidence (20). Below
          -- even the cheap floor's 25 — here real dollars are at stake and
          -- the two sources actively disagree; the floor shows only so the
          -- card isn't blank, not because we trust the figure.
          when p.moderate_diverged_floor and p.public_market_price is not null
            then 20
          when p.private_trust_status in ('PRICECHARTING_PRIMARY', 'PRICECHARTING_DIVERGED', 'NO_TRUSTED_PRICE')
            then 0
          when p.raw_market_price_outlier
            then 0
          when p.public_market_price is not null
            then least(coalesce(p.market_confidence_score, 25), 35)
          else 0
        end
      -- Thin-tier JP rows: low confidence (30) — mirrors the EN well-sampled
      -- single-source PriceCharting rate above: the price is surfaced but
      -- explicitly de-rated vs the 90 of a two-source MATCH. Sits ahead of
      -- the outlier branch for the same reason the JP headline branch does:
      -- the outlier flag is about the Scrydex-basis base market_price, which
      -- the JP display path never uses. Trusted (>= 3) JP rows fall through
      -- unchanged.
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then 30
      when p.raw_market_price_outlier then 0
      else p.market_confidence_score
    end as public_confidence_score,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then false
          -- Single-source PriceCharting is low confidence by construction.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then true
          else true
        end
      -- Thin-tier JP rows are low confidence by construction (the EN
      -- single-source precedent; market_low_confidence is the view's
      -- low-confidence output flag).
      when p.canonical_language = 'JP' and p.grade = 'RAW'
       and p.jp_display_price is not null
       and p.jp_display_sample_count < 3
        then true
      when p.raw_market_price_outlier then true
      else p.market_low_confidence
    end as public_low_confidence,
    case
      when p.is_en_raw then
        case
          when p.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
           and p.public_market_price is not null
            then 'POPALPHA_MARKET_CONFIDENT'
          -- Well-sampled single-source PriceCharting headline.
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
           and p.private_pricecharting_observations_7d >= 5
           and p.public_market_price is not null
            then 'POPALPHA_MARKET_SINGLE_SOURCE'
          -- Cheap diverged floor headline. MUST precede the DIVERGED quarantine
          -- branch (this row IS diverged, but we surfaced the floor).
          when p.cheap_diverged_floor and p.public_market_price is not null
            then 'POPALPHA_MARKET_CHEAP_DIVERGED_FLOOR'
          -- Moderate diverged floor headline. MUST precede the DIVERGED
          -- quarantine branch (this row IS diverged, but we surfaced the floor).
          when p.moderate_diverged_floor and p.public_market_price is not null
            then 'POPALPHA_MARKET_MODERATE_DIVERGED_FLOOR'
          when p.private_trust_status = 'PRICECHARTING_DIVERGED'
            then 'POPALPHA_MARKET_QUARANTINED'
          when p.private_trust_status = 'PRICECHARTING_PRIMARY'
            then 'NO_RELIABLE_PRICE'
          when p.raw_market_price_outlier
            then 'OUTLIER_SUPPRESSED'
          when p.public_market_price is not null
            then 'POPALPHA_MARKET_LOW_CONFIDENCE'
          else 'NO_RELIABLE_PRICE'
        end
      when p.raw_market_price_outlier then 'OUTLIER_SUPPRESSED'
      else p.market_blend_policy
    end as public_market_blend_policy
  from public_price_policy p
),
public_signal_context as (
  select
    s.*,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_price_usd
      else null
    end as recent_market_signal_usd,
    case
      when s.is_en_raw
       and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
       and s.public_market_price is not null
       and s.private_scrydex_price_usd is not null
        then s.private_scrydex_as_of
      else null
    end as recent_market_signal_as_of
  from public_signal_policy s
),
public_signal_gap as (
  select
    c.*,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
        then round((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric, 2)
      else null
    end as recent_market_signal_delta_pct,
    case
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd > c.public_market_price
        then 'HIGHER'
      when c.recent_market_signal_usd is not null
       and c.public_market_price is not null
       and c.public_market_price > 0
       and abs((c.recent_market_signal_usd - c.public_market_price)::numeric) >=
          case
            when c.public_market_price < 25 then 1
            when c.public_market_price < 100 then 5
            when c.public_market_price < 500 then 25
            else 50
          end
       and abs((((c.recent_market_signal_usd - c.public_market_price) / c.public_market_price) * 100)::numeric) >=
          case
            when c.public_market_price < 25 then 20
            when c.public_market_price < 100 then 15
            when c.public_market_price < 500 then 10
            else 8
          end
       and c.recent_market_signal_usd < c.public_market_price
        then 'LOWER'
      else null
    end as recent_market_signal_direction
  from public_signal_context c
),
public_display_policy as (
  select
    g.*,
    case
      when g.is_en_raw
       and (g.private_trust_status = 'PRICECHARTING_DIVERGED' or g.raw_market_price_outlier)
       and g.public_market_price is null
        then 'UNDER_REVIEW'
      when g.public_market_price is null
        then 'NO_RELIABLE_PRICE'
      -- Single-source PriceCharting display state (the price is non-null, so
      -- this lands before the signal-direction/ALIGNED states below).
      when g.is_en_raw
       and g.private_trust_status = 'PRICECHARTING_PRIMARY'
       and g.private_pricecharting_observations_7d >= 5
        then 'PRICECHARTING_SINGLE_SOURCE'
      -- Cheap diverged floor display state (price is non-null here — the
      -- UNDER_REVIEW / NO_RELIABLE_PRICE branches above already caught the
      -- still-suppressed diverged rows). Mirrors PRICECHARTING_SINGLE_SOURCE's
      -- position ahead of the signal-direction/ALIGNED states.
      when g.is_en_raw
       and g.cheap_diverged_floor
       and g.public_market_price is not null
        then 'PRICECHARTING_CHEAP_DIVERGED'
      -- Moderate diverged floor display state (cheap mirror; the price is
      -- non-null here for the same reason).
      when g.is_en_raw
       and g.moderate_diverged_floor
       and g.public_market_price is not null
        then 'PRICECHARTING_MODERATE_DIVERGED'
      when g.is_en_raw
       and g.private_trust_status = 'SCRYDEX_ONLY_DEMOTED'
        then 'PUBLIC_ONLY'
      -- Thin-tier JP display state (the JP-RAW headline is non-null here —
      -- the NO_RELIABLE_PRICE branch above already caught null prices, and
      -- the JP-RAW headline IS jp_display_price). Mirrors
      -- PRICECHARTING_SINGLE_SOURCE's position ahead of the
      -- signal-direction/ALIGNED states; trusted JP rows keep landing in
      -- ALIGNED exactly as before.
      when g.canonical_language = 'JP' and g.grade = 'RAW'
       and g.jp_display_price is not null
       and g.jp_display_sample_count < 3
        then 'JP_LOW_SAMPLE'
      when g.recent_market_signal_direction = 'HIGHER'
        then 'SIGNAL_HIGHER'
      when g.recent_market_signal_direction = 'LOWER'
        then 'SIGNAL_LOWER'
      else 'ALIGNED'
    end as market_price_display_state
  from public_signal_gap g
),
public_provenance_policy as (
  select
    s.*,
    case
      when s.is_en_raw then
        jsonb_strip_nulls(jsonb_build_object(
          'marketPriceLabel', 'PopAlpha Market Price',
          'marketPriceDisplayState', s.market_price_display_state,
          'recentMarketSignalDirection', s.recent_market_signal_direction,
          'recentMarketSignalDeltaPct', s.recent_market_signal_delta_pct,
          'confidenceStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
               and s.public_market_price is not null
                then 'HIGH'
              -- Cheap diverged floor: a price IS shown, low confidence.
              when s.cheap_diverged_floor and s.public_market_price is not null
                then 'LOW'
              -- Moderate diverged floor: a price IS shown, low confidence.
              when s.moderate_diverged_floor and s.public_market_price is not null
                then 'LOW'
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              when s.public_market_price is not null
                then 'LOW'
              else 'NONE'
            end,
          'publicInputStatus',
            case
              -- Cheap diverged floor uses its public inputs (it surfaces the
              -- lower of them), so the input is SUPPORTED, not quarantined.
              when s.cheap_diverged_floor and s.public_market_price is not null
                then 'SUPPORTED'
              -- Moderate diverged floor likewise surfaces the lower of its
              -- public inputs — SUPPORTED, not quarantined.
              when s.moderate_diverged_floor and s.public_market_price is not null
                then 'SUPPORTED'
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'QUARANTINED'
              -- Single-source PriceCharting has a permitted public input (the
              -- PriceCharting feed), even without Scrydex corroboration.
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
               and s.private_pricecharting_observations_7d >= 5
               and s.public_market_price is not null
                then 'SUPPORTED'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                then 'INSUFFICIENT_PUBLIC_INPUT'
              when s.public_market_price is not null
                then 'SUPPORTED'
              else 'INSUFFICIENT_PUBLIC_INPUT'
            end,
          'priceConflictStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'INTERNAL_GUARDRAIL_DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'CONSISTENT'
              when s.public_market_price is not null
                then 'PUBLIC_INPUT_ONLY'
              else 'NONE'
            end,
          'internalGuardrailStatus',
            case
              when s.private_trust_status = 'PRICECHARTING_DIVERGED' then 'DIVERGED'
              when s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH' then 'CONSISTENT'
              when s.private_trust_status = 'PRICECHARTING_PRIMARY' then 'PRIVATE_ONLY'
              else 'NOT_AVAILABLE'
            end,
          'priceAsOf', s.public_market_price_as_of,
          'movementHistorySource',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
                then 'PERMITTED_MARKET_INPUT'
              else null
            end,
          'quarantineReason',
            case
              -- Cheap diverged floor is surfaced, not quarantined.
              when s.cheap_diverged_floor and s.public_market_price is not null
                then null
              -- Moderate diverged floor is surfaced, not quarantined.
              when s.moderate_diverged_floor and s.public_market_price is not null
                then null
              when s.private_trust_status = 'PRICECHARTING_DIVERGED'
                then 'PUBLIC_INPUT_DIVERGED_FROM_INTERNAL_GUARDRAIL'
              -- Thin (<5 obs) PRIMARY still reports the missing-input reason;
              -- well-sampled PRIMARY surfaces a price, so no quarantine reason.
              when s.private_trust_status = 'PRICECHARTING_PRIMARY'
               and s.public_market_price is null
                then 'MISSING_PERMITTED_PUBLIC_INPUT'
              when s.raw_market_price_outlier and s.public_market_price is null
                then 'PUBLIC_INPUT_OUTLIER_SUPPRESSED'
              else null
            end,
          'parityStatus',
            case
              when s.public_market_price is not null
               and (s.public_change_pct_24h is not null or s.public_change_pct_7d is not null)
               and s.private_trust_status = 'PRICECHARTING_SCRYDEX_MATCH'
                then 'MATCH'
              else 'MISSING_PROVIDER'
            end,
          'sourceMix',
            jsonb_build_object(
              -- Single-source PriceCharting (PRIMARY) has a price but NO Scrydex —
              -- claim zero Scrydex weight so source-mix consumers aren't misled.
              -- Cheap diverged floor likewise surfaces a conservative floor, not
              -- a Scrydex-anchored price, so it claims zero Scrydex weight too.
              'scrydexWeight',
                case when s.cheap_diverged_floor then 0
                     -- Moderate floor: conservative floor, not Scrydex-anchored.
                     when s.moderate_diverged_floor then 0
                     when s.public_market_price is not null
                      and coalesce(s.private_trust_status, '') <> 'PRICECHARTING_PRIMARY'
                     then 1 else 0 end,
              'publicInputWeight',
                case when s.public_market_price is not null then 1 else 0 end
            ),
          'sampleCounts7d',
            jsonb_build_object(
              -- Single-source PriceCharting: no Scrydex sales (scrydex 0), and the
              -- public sample is the PriceCharting obs that passed the >=5 gate —
              -- not the absent/stale Scrydex count — so the row isn't seen as
              -- unsampled by UI / strength logic.
              'scrydex',
                case
                  when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                   and s.private_pricecharting_observations_7d >= 5
                   and s.public_market_price is not null
                    then 0
                  when coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end,
              'public',
                case
                  when s.private_trust_status = 'PRICECHARTING_PRIMARY'
                   and s.private_pricecharting_observations_7d >= 5
                   and s.public_market_price is not null
                    then s.private_pricecharting_observations_7d
                  when s.public_market_price is not null
                   and coalesce(s.market_provenance->'sampleCounts7d'->>'scrydex', '') ~ '^[0-9]+$'
                    then (s.market_provenance->'sampleCounts7d'->>'scrydex')::integer
                  else 0
                end
            )
        ))
      when s.raw_market_price_outlier then coalesce(s.market_provenance, '{}'::jsonb) || jsonb_build_object('parityStatus', 'MISSING_PROVIDER')
      else s.market_provenance
    end as public_market_provenance
  from public_display_policy s
)
select
  id,
  canonical_slug,
  printing_id,
  grade,
  median_7d,
  median_30d,
  low_30d,
  high_30d,
  trimmed_median_30d,
  volatility_30d,
  liquidity_score,
  percentile_rank,
  scarcity_adjusted_value,
  active_listings_7d,
  snapshot_count_30d,
  provider_trend_slope_7d,
  provider_trend_slope_30d,
  provider_cov_price_7d,
  provider_cov_price_30d,
  provider_price_relative_to_30d_range,
  provider_min_price_all_time,
  provider_min_price_all_time_date,
  provider_max_price_all_time,
  provider_max_price_all_time_date,
  provider_as_of_ts,
  provider_price_changes_count_30d,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as scrydex_price,
  case
    when is_en_raw and public_market_price is null then null
    when raw_market_price_outlier then null
    else coalesce(recent_market_signal_usd, scrydex_price)
  end as pokemontcg_price,
  yahoo_jp_price_out as yahoo_jp_price,
  yahoo_jp_price_jpy_out as yahoo_jp_price_jpy,
  yahoo_jp_sample_count_out as yahoo_jp_sample_count,
  yahoo_jp_observed_at_out as yahoo_jp_observed_at,
  snkrdunk_price_out as snkrdunk_price,
  snkrdunk_sample_count_out as snkrdunk_sample_count,
  snkrdunk_observed_at_out as snkrdunk_observed_at,
  snkrdunk_product_code_out as snkrdunk_product_code,
  public_market_price as market_price,
  public_market_price_as_of as market_price_as_of,
  public_provider_compare_as_of as provider_compare_as_of,
  public_confidence_score as market_confidence_score,
  public_low_confidence as market_low_confidence,
  public_market_blend_policy as market_blend_policy,
  public_market_provenance as market_provenance,
  public_change_pct_24h as change_pct_24h,
  public_change_pct_7d as change_pct_7d,
  updated_at,
  canonical_name_native,
  set_name_native,
  canonical_language as language,
  snkrdunk_price_jpy_out as snkrdunk_price_jpy,
  market_price_display_state,
  recent_market_signal_usd,
  recent_market_signal_as_of,
  recent_market_signal_delta_pct,
  recent_market_signal_direction,
  -- New columns MUST be appended last: CREATE OR REPLACE VIEW only allows
  -- adding trailing columns, not reordering existing ones.
  public_latest_price as latest_price,
  public_latest_price_as_of as latest_price_as_of,
  -- JP-native freshest hero + 14-day median (additive; raw passthrough of the
  -- new base columns). NULL for non-JP rows. iOS reads these for the JP detail
  -- hero + "14-day median" sub-line; the base market_price stays untouched.
  jp_latest_price,
  jp_latest_price_as_of,
  jp_display_price,
  jp_display_price_as_of,
  -- JP display-basis deltas (additive; raw passthrough of the new base
  -- columns). NULL for non-JP rows. Surfaced verbatim — alongside the
  -- blended change_pct_24h/7d above — so clients and debugging can attribute
  -- which basis a JP badge came from.
  jp_display_change_pct_24h,
  jp_display_change_pct_7d,
  -- Thin-tier attribution (additive; raw passthrough of the new base
  -- column). MAX in-window sample_count behind the displayed JP price:
  -- >= 3 trusted, 1-2 thin, NULL when nothing displays. Clients branch on
  -- < 3 (iOS subline lands in a separate PR).
  jp_display_sample_count
from public_provenance_policy;

grant select on public.public_card_metrics to anon, authenticated;

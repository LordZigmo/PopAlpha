-- get_attention_slugs_for_art_crop()
--
-- Server-side intersection that returns the canonical_slugs satisfying
-- BOTH:
--   (a) viewed on a card detail page in the last p_days_back days
--   (b) RAW market price ≥ p_min_price USD (no printing/grade split)
--
-- Created to bypass Supabase PostgREST's db-max-rows = 1000 cap. The
-- previous implementation in the embed-card-art-crops cron ran two
-- separate supabase-js .select() queries and intersected the results
-- in JS. With ~3,300 viewed rows and ~5,300 priced rows in the actual
-- data, both inputs were silently clipped to 1,000 rows each before
-- the JS intersection — producing 73 slugs against an actual ~1,162.
-- See commit 7cb2420 for the postmortem and 6170eba for the original
-- (broken) implementation.
--
-- Returns text[] in a single row so the row cap doesn't apply to the
-- result. Internal CTE row counts are unbounded.
--
-- p_days_back / p_min_price are parameterized rather than constants
-- so the same function can serve future selective-recovery flows
-- (homepage AI brief, personalization, etc.) without forking another
-- nearly-identical RPC.

create or replace function public.get_attention_slugs_for_art_crop(
  p_days_back integer default 14,
  p_min_price numeric default 5
)
returns text[]
language sql stable
set search_path = public
as $$
  with viewed as (
    select distinct canonical_slug
    from public_card_page_view_daily
    where view_date >= current_date - p_days_back
  ),
  priced as (
    select canonical_slug
    from card_metrics
    where printing_id is null
      and grade = 'RAW'
      and market_price >= p_min_price
  )
  select coalesce(
    array_agg(viewed.canonical_slug order by viewed.canonical_slug),
    '{}'::text[]
  )
  from viewed
  inner join priced on priced.canonical_slug = viewed.canonical_slug;
$$;

grant execute on function public.get_attention_slugs_for_art_crop(integer, numeric)
  to anon, authenticated, service_role;

comment on function public.get_attention_slugs_for_art_crop(integer, numeric) is
  'Returns canonical_slugs that have been viewed in the last p_days_back days AND are priced at or above p_min_price. Returns text[] in a single row to bypass PostgREST db-max-rows.';

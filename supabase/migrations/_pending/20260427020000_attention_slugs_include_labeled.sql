-- Expand get_attention_slugs_for_art_crop to also include labeled
-- corpus slugs (scan_eval_images.canonical_slug).
--
-- Background: the original definition (commit bfd2b11) returned
-- viewed-in-14d ∩ priced≥$5. That worked as a "user attention"
-- proxy for general use, but missed the cards we've labeled in
-- the eval corpus or via user corrections. Concretely: zero of
-- the six distinct eval cards landed in the attention set, so the
-- multi-crop kNN had no relevant references to query against on
-- eval runs. We could measure regression but not improvement.
--
-- The fix: union in scan_eval_images. That table holds eval
-- seeding labels AND user corrections from the picker sheet
-- (commits ea697a1 + 37df864 user-correction flow). Cards we've
-- explicitly said "this is the right answer" for, regardless of
-- whether the model currently agrees.
--
-- Why not scan_identify_events.top_match_slug as the secondary
-- signal: that's biased self-reinforcement. Cards the model
-- already identifies correctly become attention; cards it
-- mis-identifies stay out. Using labeled images instead means
-- the cards we MOST want to fix (those with mis-identifications
-- corrected via the picker sheet) flow into attention naturally.

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
  ),
  labeled as (
    select distinct canonical_slug
    from scan_eval_images
    where canonical_slug is not null
  )
  select coalesce(
    array_agg(canonical_slug order by canonical_slug),
    '{}'::text[]
  )
  from (
    select v.canonical_slug
    from viewed v
    inner join priced p on p.canonical_slug = v.canonical_slug
    union
    select canonical_slug from labeled
  ) attention;
$$;

comment on function public.get_attention_slugs_for_art_crop(integer, numeric) is
  'Returns canonical_slugs for: (viewed-in-p_days_back AND priced ≥ p_min_price) UNION (any slug with a label in scan_eval_images). Returns text[] in a single row to bypass PostgREST db-max-rows.';

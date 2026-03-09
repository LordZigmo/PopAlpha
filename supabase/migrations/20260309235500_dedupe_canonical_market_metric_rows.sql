-- Patch the already-deployed 20260309234500 metrics functions in-place so
-- canonical RAW compare rows do not duplicate when null-printing snapshots
-- already exist. This is idempotent on fresh environments where the corrected
-- 20260309234500 file has already been applied.

do $$
declare
  v_def text;
  v_old_provider_compare text := $q$  provider_compare as (
    select * from printing_compare
    union all
    select * from canonical_compare
  ),$q$;
  v_new_provider_compare text := $q$  provider_compare as (
    select * from printing_compare
    where printing_id is not null
    union all
    select * from canonical_compare
  ),$q$;
  v_old_rank_tail text := $q$    from computed c
    join public.canonical_cards cc
      on cc.slug = c.canonical_slug
  )
  insert into public.card_metrics (
$q$;
  v_new_rank_tail text := $q$    from computed c
    join public.canonical_cards cc
      on cc.slug = c.canonical_slug
  ),
  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from ranked r
    order by
      r.canonical_slug,
      r.printing_id,
      r.grade,
      r.provider_compare_as_of desc nulls last,
      r.market_price_as_of desc nulls last
  )
  insert into public.card_metrics (
$q$;
  v_old_insert_source text := $q$  from ranked r$q$;
  v_new_insert_source text := $q$  from deduped_ranked r$q$;
begin
  v_def := pg_get_functiondef('public.refresh_card_metrics()'::regprocedure);
  if position(v_old_provider_compare in v_def) > 0 then
    v_def := replace(v_def, v_old_provider_compare, v_new_provider_compare);
  elsif position(v_new_provider_compare in v_def) = 0 then
    raise exception 'refresh_card_metrics(): provider_compare snippet not found';
  end if;

  if position(v_old_rank_tail in v_def) > 0 then
    v_def := replace(v_def, v_old_rank_tail, v_new_rank_tail);
  elsif position(v_new_rank_tail in v_def) = 0 then
    raise exception 'refresh_card_metrics(): ranked tail snippet not found';
  end if;

  if position(v_old_insert_source in v_def) > 0 then
    v_def := replace(v_def, v_old_insert_source, v_new_insert_source);
  elsif position(v_new_insert_source in v_def) = 0 then
    raise exception 'refresh_card_metrics(): insert source snippet not found';
  end if;

  execute v_def;

  v_def := pg_get_functiondef('public.refresh_card_metrics_for_variants(jsonb)'::regprocedure);
  if position(v_old_provider_compare in v_def) > 0 then
    v_def := replace(v_def, v_old_provider_compare, v_new_provider_compare);
  elsif position(v_new_provider_compare in v_def) = 0 then
    raise exception 'refresh_card_metrics_for_variants(jsonb): provider_compare snippet not found';
  end if;

  if position(v_old_rank_tail in v_def) > 0 then
    v_def := replace(v_def, v_old_rank_tail, v_new_rank_tail);
  elsif position(v_new_rank_tail in v_def) = 0 then
    raise exception 'refresh_card_metrics_for_variants(jsonb): ranked tail snippet not found';
  end if;

  if position(v_old_insert_source in v_def) > 0 then
    v_def := replace(v_def, v_old_insert_source, v_new_insert_source);
  elsif position(v_new_insert_source in v_def) = 0 then
    raise exception 'refresh_card_metrics_for_variants(jsonb): insert source snippet not found';
  end if;

  execute v_def;
end;
$$;

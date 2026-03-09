-- Fix the accidental self-reference introduced by the 20260309235500 patch.
-- This is idempotent on environments where the deduped CTE already points at
-- the ranked CTE.

do $$
declare
  v_def text;
  v_broken text := $q$  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from deduped_ranked r
    order by$q$;
  v_fixed text := $q$  deduped_ranked as (
    select distinct on (r.canonical_slug, r.printing_id, r.grade)
      r.*
    from ranked r
    order by$q$;
begin
  v_def := pg_get_functiondef('public.refresh_card_metrics()'::regprocedure);
  if position(v_broken in v_def) > 0 then
    v_def := replace(v_def, v_broken, v_fixed);
    execute v_def;
  elsif position(v_fixed in v_def) = 0 then
    raise exception 'refresh_card_metrics(): deduped_ranked source snippet not found';
  end if;

  v_def := pg_get_functiondef('public.refresh_card_metrics_for_variants(jsonb)'::regprocedure);
  if position(v_broken in v_def) > 0 then
    v_def := replace(v_def, v_broken, v_fixed);
    execute v_def;
  elsif position(v_fixed in v_def) = 0 then
    raise exception 'refresh_card_metrics_for_variants(jsonb): deduped_ranked source snippet not found';
  end if;
end;
$$;

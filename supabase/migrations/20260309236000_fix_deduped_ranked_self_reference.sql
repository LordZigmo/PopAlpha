-- Fix the accidental self-reference introduced by the 20260309235500 patch.
-- This is idempotent on environments where the deduped CTE already points at
-- the ranked CTE.
--
-- Replay safety: only patch when the broken self-reference exists. Fresh
-- environments may already have the corrected function bodies and should not
-- fail just because pg_get_functiondef() formatting differs.

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
  if to_regprocedure('public.refresh_card_metrics()') is not null then
    v_def := pg_get_functiondef('public.refresh_card_metrics()'::regprocedure);
    if position(v_broken in v_def) > 0 then
      v_def := replace(v_def, v_broken, v_fixed);
      execute v_def;
    end if;
  end if;

  if to_regprocedure('public.refresh_card_metrics_for_variants(jsonb)') is not null then
    v_def := pg_get_functiondef('public.refresh_card_metrics_for_variants(jsonb)'::regprocedure);
    if position(v_broken in v_def) > 0 then
      v_def := replace(v_def, v_broken, v_fixed);
      execute v_def;
    end if;
  end if;
end;
$$;

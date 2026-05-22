-- Authenticated users can write user-owned rows that fire
-- set_grade_id_from_grade(); that trigger calls resolve_grade_id(text).
-- Keep the helper closed to anon while allowing the authenticated write
-- path to resolve trusted grade catalog ids.

do $$
declare
  target_fn regprocedure := to_regprocedure('public.resolve_grade_id(text)');
begin
  if target_fn is not null then
    execute format(
      'revoke execute on function %s from public, anon',
      target_fn
    );
    execute format(
      'grant execute on function %s to authenticated, service_role',
      target_fn
    );
  end if;
end $$;

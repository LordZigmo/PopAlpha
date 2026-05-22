-- Pin the SECURITY DEFINER prune helper's search_path.
--
-- The linked schema guardrail requires every SECURITY DEFINER function
-- to run with an explicit search_path so object resolution cannot be
-- influenced by caller-controlled schema state.

alter function public.prune_old_data()
  set search_path = public;

-- Advisor follow-ups for the variant_token_registry migration.

alter view public.public_stamp_display_labels
  set (security_invoker = true);

drop policy if exists variant_token_registry_no_anon
  on public.variant_token_registry;

drop policy if exists variant_token_registry_anon_read_safe_rows
  on public.variant_token_registry;
create policy variant_token_registry_anon_read_safe_rows
  on public.variant_token_registry
  for select
  to anon, authenticated
  using (status in ('approved', 'auto') and normalized_stamp <> 'NONE');

revoke all on public.variant_token_registry from anon, authenticated;
grant select (normalized_stamp, display_label, status)
  on public.variant_token_registry
  to anon, authenticated;

alter function public.variant_token_display_label(text)
  set search_path = public, pg_temp;

alter function public.variant_token_registry_touch_row(text, text, text, numeric)
  set search_path = public, pg_temp;

alter function public.variant_token_registry_touch_updated_at()
  set search_path = public, pg_temp;

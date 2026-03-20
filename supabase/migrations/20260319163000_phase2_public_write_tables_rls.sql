-- Phase 2.4:
-- Enable row-level security on public-write tables while preserving their
-- least-privilege contracts.

alter table public.waitlist_signups enable row level security;
alter table public.card_page_views enable row level security;

revoke all on table public.waitlist_signups from anon, authenticated;
grant insert on table public.waitlist_signups to anon, authenticated;

revoke usage, select, update on sequence public.waitlist_signups_id_seq from anon, authenticated;
grant usage on sequence public.waitlist_signups_id_seq to anon, authenticated;

drop policy if exists waitlist_signups_public_insert_anon on public.waitlist_signups;
create policy waitlist_signups_public_insert_anon
on public.waitlist_signups
for insert
to anon
with check (
  clerk_user_id is null
  and source = 'pricing_modal'
  and desired_tier in ('Ace', 'Elite')
  and email_normalized <> ''
  and email_normalized = lower(email_normalized)
);

drop policy if exists waitlist_signups_public_insert_authenticated on public.waitlist_signups;
create policy waitlist_signups_public_insert_authenticated
on public.waitlist_signups
for insert
to authenticated
with check (
  clerk_user_id = public.requesting_clerk_user_id()
  and source = 'pricing_modal'
  and desired_tier in ('Ace', 'Elite')
  and email_normalized <> ''
  and email_normalized = lower(email_normalized)
);

revoke all on table public.card_page_views from anon, authenticated;
revoke usage, select, update on sequence public.card_page_views_id_seq from anon, authenticated;

create table if not exists public.waitlist_signups (
  id bigserial primary key,
  email text not null,
  email_normalized text not null,
  desired_tier text not null check (desired_tier in ('Ace', 'Elite')),
  source text not null default 'pricing_modal',
  clerk_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists waitlist_signups_email_tier_idx
  on public.waitlist_signups (email_normalized, desired_tier);

create index if not exists waitlist_signups_created_at_idx
  on public.waitlist_signups (created_at desc);

create or replace function public.set_waitlist_signups_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists waitlist_signups_set_updated_at on public.waitlist_signups;

create trigger waitlist_signups_set_updated_at
before update on public.waitlist_signups
for each row
execute function public.set_waitlist_signups_updated_at();

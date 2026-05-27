-- Pro-gate per-card AI market summaries.
--
-- `card_profiles` contains the card-level AI summary shown as
-- "Where this card stands today". It used to be part of the direct
-- anon/auth public-read contract. Product now treats this as Pro-only,
-- so clients must read it through `/api/card-profiles`, where Clerk auth
-- and `hasPro()` are enforced before the service-role query runs.

alter table public.card_profiles enable row level security;

revoke all on table public.card_profiles from anon, authenticated;

drop policy if exists card_profiles_public_read on public.card_profiles;

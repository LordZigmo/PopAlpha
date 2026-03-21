-- Phase 1 RLS foundation for Clerk-native auth.
-- Standardizes Clerk text ownership, adds least-privilege policies,
-- and narrows public contracts to explicit views/functions.

create or replace function public.requesting_clerk_user_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

create or replace function public.is_handle_available(desired_handle_norm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when desired_handle_norm is null or btrim(desired_handle_norm) = '' then false
      else not exists (
        select 1
        from public.app_users
        where handle_norm = lower(btrim(desired_handle_norm))
      )
    end;
$$;

revoke all on function public.is_handle_available(text) from public;
grant execute on function public.is_handle_available(text) to anon, authenticated;

create or replace function public.resolve_profile_handle(desired_handle_norm text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select au.clerk_user_id
  from public.app_users au
  where au.handle is not null
    and au.handle_norm = lower(btrim(desired_handle_norm))
  limit 1;
$$;

revoke all on function public.resolve_profile_handle(text) from public;
grant execute on function public.resolve_profile_handle(text) to authenticated;

alter table public.app_users
  alter column clerk_user_id set default public.requesting_clerk_user_id();

alter table public.holdings
  alter column owner_clerk_id set default public.requesting_clerk_user_id();

alter table public.private_sales
  add column if not exists owner_clerk_id text;

alter table public.private_sales
  alter column owner_clerk_id set default public.requesting_clerk_user_id();

create index if not exists private_sales_owner_clerk_id_idx
  on public.private_sales (owner_clerk_id);

create index if not exists private_sales_owner_clerk_cert_idx
  on public.private_sales (owner_clerk_id, cert, sold_at desc);

alter table public.profile_posts
  alter column owner_id set default public.requesting_clerk_user_id();

alter table public.profile_follows
  alter column follower_id set default public.requesting_clerk_user_id();

alter table public.push_subscriptions
  alter column clerk_user_id set default public.requesting_clerk_user_id();

alter table public.community_card_votes
  alter column voter_id set default public.requesting_clerk_user_id();

drop view if exists public.public_user_profiles;
create view public.public_user_profiles as
select
  handle,
  handle_norm,
  created_at,
  profile_bio,
  profile_banner_url
from public.app_users
where handle is not null
  and profile_visibility = 'PUBLIC';

revoke all on table public.public_user_profiles from anon, authenticated;
grant select on table public.public_user_profiles to anon, authenticated;

drop view if exists public.public_profile_posts;
create view public.public_profile_posts as
select
  pp.id,
  au.handle,
  pp.body,
  pp.created_at
from public.profile_posts pp
join public.app_users au
  on au.clerk_user_id = pp.owner_id
where au.handle is not null
  and au.profile_visibility = 'PUBLIC';

revoke all on table public.public_profile_posts from anon, authenticated;
grant select on table public.public_profile_posts to anon, authenticated;

drop view if exists public.public_profile_social_stats;
create view public.public_profile_social_stats as
with public_users as (
  select clerk_user_id, handle
  from public.app_users
  where handle is not null
    and profile_visibility = 'PUBLIC'
),
post_counts as (
  select owner_id, count(*)::int as post_count
  from public.profile_posts
  group by owner_id
),
follower_counts as (
  select followee_id as owner_id, count(*)::int as follower_count
  from public.profile_follows
  group by followee_id
),
following_counts as (
  select follower_id as owner_id, count(*)::int as following_count
  from public.profile_follows
  group by follower_id
)
select
  pu.handle,
  coalesce(pc.post_count, 0) as post_count,
  coalesce(fc.follower_count, 0) as follower_count,
  coalesce(fgc.following_count, 0) as following_count
from public_users pu
left join post_counts pc on pc.owner_id = pu.clerk_user_id
left join follower_counts fc on fc.owner_id = pu.clerk_user_id
left join following_counts fgc on fgc.owner_id = pu.clerk_user_id;

revoke all on table public.public_profile_social_stats from anon, authenticated;
grant select on table public.public_profile_social_stats to anon, authenticated;

drop view if exists public.public_profile_post_mentions;
create view public.public_profile_post_mentions as
select
  pm.post_id,
  pm.canonical_slug,
  pm.mention_text,
  pm.start_index,
  pm.end_index
from public.profile_post_card_mentions pm
join public.profile_posts pp
  on pp.id = pm.post_id
join public.app_users au
  on au.clerk_user_id = pp.owner_id
where au.handle is not null
  and au.profile_visibility = 'PUBLIC';

revoke all on table public.public_profile_post_mentions from anon, authenticated;
grant select on table public.public_profile_post_mentions to anon, authenticated;

drop view if exists public.community_user_vote_weeks;
create view public.community_user_vote_weeks
with (security_invoker = true) as
select
  voter_id,
  week_start,
  count(*)::integer as votes_used,
  greatest(0, 10 - count(*))::integer as votes_remaining,
  min(created_at) as first_vote_at,
  max(created_at) as last_vote_at
from public.community_card_votes
group by voter_id, week_start;

revoke all on table public.community_user_vote_weeks from anon, authenticated;
grant select on table public.community_user_vote_weeks to authenticated;

drop view if exists public.community_vote_feed_events;
create view public.community_vote_feed_events
with (security_invoker = true) as
select
  ccv.id,
  ccv.voter_id,
  ccv.canonical_slug,
  ccv.vote_side,
  ccv.week_start,
  ccv.created_at,
  cc.canonical_name,
  cc.set_name
from public.community_card_votes ccv
left join public.canonical_cards cc
  on cc.slug = ccv.canonical_slug;

revoke all on table public.community_vote_feed_events from anon, authenticated;
grant select on table public.community_vote_feed_events to authenticated;

drop view if exists public.public_community_vote_totals;
create view public.public_community_vote_totals as
select
  week_start,
  canonical_slug,
  count(*) filter (where vote_side = 'up')::int as bullish_votes,
  count(*) filter (where vote_side = 'down')::int as bearish_votes,
  count(*)::int as total_votes
from public.community_card_votes
group by week_start, canonical_slug;

revoke all on table public.public_community_vote_totals from anon, authenticated;
grant select on table public.public_community_vote_totals to anon, authenticated;

alter table public.app_users enable row level security;
alter table public.holdings enable row level security;
alter table public.private_sales enable row level security;
alter table public.profile_posts enable row level security;
alter table public.profile_follows enable row level security;
alter table public.profile_post_card_mentions enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.community_card_votes enable row level security;

drop policy if exists app_users_self_select on public.app_users;
drop policy if exists app_users_self_insert on public.app_users;
drop policy if exists app_users_self_update on public.app_users;

create policy app_users_self_select on public.app_users
  for select to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id());

create policy app_users_self_insert on public.app_users
  for insert to authenticated
  with check (clerk_user_id = public.requesting_clerk_user_id());

create policy app_users_self_update on public.app_users
  for update to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id())
  with check (clerk_user_id = public.requesting_clerk_user_id());

drop policy if exists delete_own_holdings on public.holdings;
drop policy if exists holdings_user_delete on public.holdings;
drop policy if exists holdings_user_insert on public.holdings;
drop policy if exists holdings_user_select on public.holdings;
drop policy if exists holdings_user_update on public.holdings;
drop policy if exists insert_own_holdings on public.holdings;
drop policy if exists select_own_holdings on public.holdings;
drop policy if exists update_own_holdings on public.holdings;
drop policy if exists holdings_owner_clerk_select on public.holdings;
drop policy if exists holdings_owner_clerk_insert on public.holdings;
drop policy if exists holdings_owner_clerk_update on public.holdings;
drop policy if exists holdings_owner_clerk_delete on public.holdings;

create policy holdings_owner_clerk_select on public.holdings
  for select to authenticated
  using (owner_clerk_id = public.requesting_clerk_user_id());

create policy holdings_owner_clerk_insert on public.holdings
  for insert to authenticated
  with check (owner_clerk_id = public.requesting_clerk_user_id());

create policy holdings_owner_clerk_update on public.holdings
  for update to authenticated
  using (owner_clerk_id = public.requesting_clerk_user_id())
  with check (owner_clerk_id = public.requesting_clerk_user_id());

create policy holdings_owner_clerk_delete on public.holdings
  for delete to authenticated
  using (owner_clerk_id = public.requesting_clerk_user_id());

drop policy if exists private_sales_user_delete on public.private_sales;
drop policy if exists private_sales_user_insert on public.private_sales;
drop policy if exists private_sales_user_select on public.private_sales;
drop policy if exists private_sales_owner_clerk_select on public.private_sales;
drop policy if exists private_sales_owner_clerk_insert on public.private_sales;
drop policy if exists private_sales_owner_clerk_delete on public.private_sales;

create policy private_sales_owner_clerk_select on public.private_sales
  for select to authenticated
  using (owner_clerk_id = public.requesting_clerk_user_id());

create policy private_sales_owner_clerk_insert on public.private_sales
  for insert to authenticated
  with check (owner_clerk_id = public.requesting_clerk_user_id());

create policy private_sales_owner_clerk_delete on public.private_sales
  for delete to authenticated
  using (owner_clerk_id = public.requesting_clerk_user_id());

drop policy if exists profile_posts_owner_select on public.profile_posts;
drop policy if exists profile_posts_owner_insert on public.profile_posts;
drop policy if exists profile_posts_owner_update on public.profile_posts;
drop policy if exists profile_posts_owner_delete on public.profile_posts;

create policy profile_posts_owner_select on public.profile_posts
  for select to authenticated
  using (owner_id = public.requesting_clerk_user_id());

create policy profile_posts_owner_insert on public.profile_posts
  for insert to authenticated
  with check (owner_id = public.requesting_clerk_user_id());

create policy profile_posts_owner_update on public.profile_posts
  for update to authenticated
  using (owner_id = public.requesting_clerk_user_id())
  with check (owner_id = public.requesting_clerk_user_id());

create policy profile_posts_owner_delete on public.profile_posts
  for delete to authenticated
  using (owner_id = public.requesting_clerk_user_id());

drop policy if exists profile_follows_visible_rows on public.profile_follows;
drop policy if exists profile_follows_owner_insert on public.profile_follows;
drop policy if exists profile_follows_owner_delete on public.profile_follows;

create policy profile_follows_visible_rows on public.profile_follows
  for select to authenticated
  using (
    follower_id = public.requesting_clerk_user_id()
    or followee_id = public.requesting_clerk_user_id()
  );

create policy profile_follows_owner_insert on public.profile_follows
  for insert to authenticated
  with check (follower_id = public.requesting_clerk_user_id());

create policy profile_follows_owner_delete on public.profile_follows
  for delete to authenticated
  using (follower_id = public.requesting_clerk_user_id());

drop policy if exists profile_post_card_mentions_owner_select on public.profile_post_card_mentions;
drop policy if exists profile_post_card_mentions_owner_insert on public.profile_post_card_mentions;
drop policy if exists profile_post_card_mentions_owner_delete on public.profile_post_card_mentions;

create policy profile_post_card_mentions_owner_select on public.profile_post_card_mentions
  for select to authenticated
  using (
    exists (
      select 1
      from public.profile_posts pp
      where pp.id = profile_post_card_mentions.post_id
        and pp.owner_id = public.requesting_clerk_user_id()
    )
  );

create policy profile_post_card_mentions_owner_insert on public.profile_post_card_mentions
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.profile_posts pp
      where pp.id = profile_post_card_mentions.post_id
        and pp.owner_id = public.requesting_clerk_user_id()
    )
  );

create policy profile_post_card_mentions_owner_delete on public.profile_post_card_mentions
  for delete to authenticated
  using (
    exists (
      select 1
      from public.profile_posts pp
      where pp.id = profile_post_card_mentions.post_id
        and pp.owner_id = public.requesting_clerk_user_id()
    )
  );

drop policy if exists push_subscriptions_owner_select on public.push_subscriptions;
drop policy if exists push_subscriptions_owner_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_owner_update on public.push_subscriptions;
drop policy if exists push_subscriptions_owner_delete on public.push_subscriptions;

create policy push_subscriptions_owner_select on public.push_subscriptions
  for select to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id());

create policy push_subscriptions_owner_insert on public.push_subscriptions
  for insert to authenticated
  with check (clerk_user_id = public.requesting_clerk_user_id());

create policy push_subscriptions_owner_update on public.push_subscriptions
  for update to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id())
  with check (clerk_user_id = public.requesting_clerk_user_id());

create policy push_subscriptions_owner_delete on public.push_subscriptions
  for delete to authenticated
  using (clerk_user_id = public.requesting_clerk_user_id());

drop policy if exists community_card_votes_visible_rows on public.community_card_votes;
drop policy if exists community_card_votes_owner_insert on public.community_card_votes;

create policy community_card_votes_visible_rows on public.community_card_votes
  for select to authenticated
  using (
    voter_id = public.requesting_clerk_user_id()
    or exists (
      select 1
      from public.profile_follows pf
      where pf.follower_id = public.requesting_clerk_user_id()
        and pf.followee_id = community_card_votes.voter_id
    )
  );

create policy community_card_votes_owner_insert on public.community_card_votes
  for insert to authenticated
  with check (voter_id = public.requesting_clerk_user_id());

revoke all on table public.app_users from anon, authenticated;
grant select, insert, update on table public.app_users to authenticated;

revoke all on table public.holdings from anon, authenticated;
grant select, insert, update, delete on table public.holdings to authenticated;

revoke all on table public.private_sales from anon, authenticated;
grant select, insert, delete on table public.private_sales to authenticated;

revoke all on table public.profile_posts from anon, authenticated;
grant select, insert, update, delete on table public.profile_posts to authenticated;

revoke all on table public.profile_follows from anon, authenticated;
grant select, insert, delete on table public.profile_follows to authenticated;

revoke all on table public.profile_post_card_mentions from anon, authenticated;
grant select, insert, delete on table public.profile_post_card_mentions to authenticated;

revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

revoke all on table public.community_card_votes from anon, authenticated;
grant select, insert on table public.community_card_votes to authenticated;

grant usage, select on sequence public.profile_posts_id_seq to authenticated;
grant usage, select on sequence public.profile_post_card_mentions_id_seq to authenticated;
grant usage, select on sequence public.push_subscriptions_id_seq to authenticated;
grant usage, select on sequence public.community_card_votes_id_seq to authenticated;

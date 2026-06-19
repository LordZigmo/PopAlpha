-- Cross-user actor identity for the social surfaces (activity feed,
-- notifications, comments, card activity).
--
-- app_users has a self-only SELECT policy (app_users_self_select:
-- clerk_user_id = requesting_clerk_user_id(), from
-- 20260318100000_phase1_clerk_rls_foundation.sql), so the user-bound RLS
-- client can only read the requester's own row. That means hydrating other
-- actors (followed users, commenters, notification sources) directly off
-- app_users returns no rows — their handle falls back to "collector" and
-- their avatar to null. (This already affected handles before avatars were
-- added.)
--
-- Mirror the existing resolve_profile_handle pattern: a SECURITY DEFINER
-- function that exposes ONLY the public profile slice (handle + avatar) for a
-- set of user ids. handle and avatar are already public (public /u/<handle>
-- pages; resolve_profile_handle resolves any handle), so this introduces no
-- new exposure — it does not return notification settings, visibility, or any
-- private column.
create or replace function public.get_actor_profiles(p_user_ids text[])
returns table (clerk_user_id text, handle text, profile_image_url text)
language sql
stable
security definer
set search_path = public
as $$
  select au.clerk_user_id, au.handle, au.profile_image_url
  from public.app_users au
  where au.clerk_user_id = any(p_user_ids);
$$;

revoke all on function public.get_actor_profiles(text[]) from public;
grant execute on function public.get_actor_profiles(text[]) to authenticated;

comment on function public.get_actor_profiles(text[]) is
  'Public profile slice (handle + avatar) for cross-user actor hydration on the activity surfaces. SECURITY DEFINER deliberately bypasses app_users self-only RLS; returns only public columns. Calling surfaces gate which actors appear (follow/block relationships, public profile pages).';

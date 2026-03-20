-- Phase 3.2:
-- Reassert view-level grant contracts in the exposed public schema.

do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'canonical_set_catalog',
    'public_card_metrics',
    'public_card_page_view_daily',
    'public_card_page_view_totals',
    'public_community_vote_totals',
    'public_market_latest',
    'public_price_history',
    'public_profile_post_mentions',
    'public_profile_posts',
    'public_profile_social_stats',
    'public_psa_snapshots',
    'public_set_finish_summary',
    'public_set_summaries',
    'public_user_profiles',
    'public_variant_metrics',
    'public_variant_movers',
    'public_variant_movers_priced'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', view_name);
    execute format('grant select on table public.%I to anon, authenticated', view_name);
  end loop;
end
$$;

do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'community_user_vote_weeks',
    'community_vote_feed_events'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', view_name);
    execute format('grant select on table public.%I to authenticated', view_name);
  end loop;
end
$$;

do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'market_snapshot_rollups',
    'pro_card_metrics',
    'pro_variant_metrics'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated', view_name);
  end loop;
end
$$;

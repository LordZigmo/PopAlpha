revoke usage, select, update on sequence public.card_page_views_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.community_card_votes_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.matching_quality_audits_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.outlier_excluded_points_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.pipeline_jobs_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.pricing_alert_events_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.pricing_transparency_snapshots_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.profile_post_card_mentions_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.profile_posts_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.psa_cert_lookup_logs_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.push_subscriptions_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.realized_sales_backtest_snapshots_id_seq from public, anon, authenticated;
revoke usage, select, update on sequence public.waitlist_signups_id_seq from public, anon, authenticated;

grant usage on sequence public.community_card_votes_id_seq to authenticated;
grant usage on sequence public.profile_post_card_mentions_id_seq to authenticated;
grant usage on sequence public.profile_posts_id_seq to authenticated;
grant usage on sequence public.push_subscriptions_id_seq to authenticated;
grant usage on sequence public.waitlist_signups_id_seq to anon, authenticated;

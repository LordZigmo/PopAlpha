-- 20260430040100_personalization_event_type_ai_brief.sql
--
-- Extend the personalization_behavior_events.event_type CHECK constraint
-- to accept "ai_brief_read_more_tapped" — the new iOS analytics event
-- fired when a user taps "Read more" on the homepage AI Brief card.
--
-- Mirrors EVENT_TYPES in lib/personalization/constants.ts and the iOS
-- PersonalizedEvent.EventType enum case `aiBriefReadMoreTapped`.
--
-- This is a constraint replacement, not a data migration — no rows
-- change. The drop+add sequence is atomic inside the transaction.

ALTER TABLE public.personalization_behavior_events
  DROP CONSTRAINT IF EXISTS personalization_behavior_events_event_type_check;

ALTER TABLE public.personalization_behavior_events
  ADD CONSTRAINT personalization_behavior_events_event_type_check
  CHECK (event_type IN (
    'card_view',
    'card_search_click',
    'watchlist_add',
    'collection_add',
    'variant_switch',
    'market_signal_expand',
    'ai_analysis_expand',
    'ai_brief_read_more_tapped',
    'price_history_expand',
    'compare_open',
    'portfolio_open'
  ));

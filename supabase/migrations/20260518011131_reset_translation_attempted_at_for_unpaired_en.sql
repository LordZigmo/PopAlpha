-- 20260518011131_reset_translation_attempted_at_for_unpaired_en.sql
--
-- One-shot reset of `canonical_cards.translation_attempted_at` for EN
-- rows that the refresh-card-translations cron has already tried under
-- the old glossary-only gate (PR #67) without finding a pairing. Without
-- this reset the cron's 14-day retry window would skip those slugs
-- until 2026-05-29+, and the new STRICT_MATCH gate shipped alongside
-- this migration wouldn't see them until well after the operator
-- backfill catches up.
--
-- Diagnosis driving this reset: the first prod cron run after the
-- May 15 case-sensitivity fix (commit eb0f8e2) attempted 500 EN
-- slugs and produced 1 pairing (0.2% yield). Population check at
-- 2026-05-18 showed all 499 attempted-unpaired slugs have at least
-- one JP candidate with matching canonical_name; 250 have name AND
-- card_number agreement. The new gate logic in
-- lib/jp/translation-match.mjs unlocks this — but only if the cron
-- (or operator backfill) re-attempts those slugs.
--
-- Scope: ONLY rows that were attempted and are still unpaired. Rows
-- that paired successfully (the 1 Eevee match) keep their stamp;
-- never-attempted rows (translation_attempted_at IS NULL) are
-- untouched. Idempotent: running this migration twice is a no-op
-- because the second run finds zero matching rows.

update public.canonical_cards
   set translation_attempted_at = null
 where language = 'EN'
   and translation_attempted_at is not null
   and not exists (
     select 1
       from public.card_translations ct
      where ct.en_slug = canonical_cards.slug
        and ct.rank = 0
   );

-- 20260424030000_card_profiles_signals.sql
--
-- Card profiles get an actionable signal layer: a coarse signal_label,
-- a verdict, and a punchy chip phrase for badge rendering. These let the
-- iOS / web card pages surface a "why this matters" pill in addition to
-- the existing prose summaries.
--
-- All three columns are nullable so existing rows stay valid until the
-- next refresh cycle rewrites them.

alter table public.card_profiles
  add column if not exists signal_label text null,
  add column if not exists verdict      text null,
  add column if not exists chip         text null;

-- Constrain signal_label and verdict to the enums the LLM is told to use.
-- A NULL value is allowed (legacy / fallback rows that don't have one).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'card_profiles_signal_label_check'
  ) then
    alter table public.card_profiles
      add constraint card_profiles_signal_label_check
      check (signal_label is null or signal_label in (
        'BREAKOUT', 'COOLING', 'VALUE_ZONE', 'STEADY', 'OVERHEATED'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'card_profiles_verdict_check'
  ) then
    alter table public.card_profiles
      add constraint card_profiles_verdict_check
      check (verdict is null or verdict in (
        'UNDERVALUED', 'FAIR', 'OVERHEATED', 'INSUFFICIENT_DATA'
      ));
  end if;
end $$;

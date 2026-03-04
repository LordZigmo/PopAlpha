-- Rename normalized card number column to match the general normalized_* convention.

alter table public.provider_normalized_observations
  rename column card_number_normalized to normalized_card_number;

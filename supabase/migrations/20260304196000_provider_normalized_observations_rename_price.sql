-- Rename staged provider price column to make it explicit that this is the
-- observed provider snapshot value, not a canonical consumer-facing price.

alter table public.provider_normalized_observations
  rename column price_value to observed_price;

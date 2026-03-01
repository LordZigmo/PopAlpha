-- Legacy uniqueness on card_id/source/mapping_type blocks multiple printing
-- mappings that belong to the same provider card. The authoritative printing
-- uniqueness is now enforced by source/mapping_type/printing_id instead.

drop index if exists public.card_external_mappings_unique_idx;

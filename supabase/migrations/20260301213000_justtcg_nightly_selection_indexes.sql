-- Speed up the nightly JustTCG refresh path, which pages printing-backed
-- JustTCG mappings by most recently refreshed mappings first.

create index if not exists card_external_mappings_justtcg_nightly_idx
  on public.card_external_mappings (source, created_at desc)
  where source = 'JUSTTCG' and printing_id is not null;

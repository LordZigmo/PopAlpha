create unique index if not exists card_printings_source_source_id_unique_idx
  on public.card_printings (source, source_id)
  where source_id is not null;

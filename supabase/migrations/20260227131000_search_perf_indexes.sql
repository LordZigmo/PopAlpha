create index if not exists card_aliases_alias_lower_idx
  on public.card_aliases ((lower(alias)));

create index if not exists canonical_cards_subject_lower_idx
  on public.canonical_cards ((lower(subject)));

create index if not exists canonical_cards_canonical_name_lower_idx
  on public.canonical_cards ((lower(canonical_name)));

create index if not exists canonical_cards_set_name_lower_idx
  on public.canonical_cards ((lower(set_name)));

create index if not exists canonical_cards_card_number_idx
  on public.canonical_cards (card_number);

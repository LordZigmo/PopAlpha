-- 20260301160000_card_detail_identity_axis.sql
--
-- Establishes canonical_cards.slug as the UI root identity and adds
-- printing-addressable identity for variant_metrics.

alter table public.cards
  add column if not exists canonical_slug text null references public.canonical_cards(slug) on delete set null;

create index if not exists cards_canonical_slug_idx
  on public.cards (canonical_slug)
  where canonical_slug is not null;

update public.cards c
set canonical_slug = cc.slug
from public.canonical_cards cc
where c.canonical_slug is null
  and c.slug = cc.slug;

update public.cards c
set canonical_slug = matched.canonical_slug
from (
  select
    c2.id as card_id,
    min(cp.canonical_slug) as canonical_slug
  from public.cards c2
  join public.card_printings cp
    on cp.source = 'pokemontcg'
   and cp.source_id like c2.id || ':%'
  group by c2.id
) matched
where c.id = matched.card_id
  and c.canonical_slug is null;

alter table public.variant_metrics
  add column if not exists printing_id uuid null references public.card_printings(id) on delete set null;

create index if not exists variant_metrics_printing_id_idx
  on public.variant_metrics (printing_id)
  where printing_id is not null;

create index if not exists variant_metrics_identity_lookup_idx
  on public.variant_metrics (canonical_slug, printing_id, provider, grade)
  where printing_id is not null;

create unique index if not exists variant_metrics_slug_printing_provider_grade_uidx
  on public.variant_metrics (canonical_slug, printing_id, provider, grade)
  where printing_id is not null;

update public.variant_metrics vm
set printing_id = cp.id
from public.card_printings cp
where vm.printing_id is null
  and vm.variant_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and cp.id::text = vm.variant_ref
  and cp.canonical_slug = vm.canonical_slug;

update public.variant_metrics vm
set printing_id = pa.printing_id
from public.printing_aliases pa
join public.card_printings cp
  on cp.id = pa.printing_id
where vm.printing_id is null
  and lower(pa.alias) = lower(vm.variant_ref)
  and cp.canonical_slug = vm.canonical_slug;

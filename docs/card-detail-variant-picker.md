# Card Detail Variant Picker — Two-Tier Rule

## The rule

The card detail variant picker has **exactly two tiers**:

1. **Primary tier** — one pill per *finish*: `Regular | Reverse Holo | Holo | Alt Art`. Always rendered when there's more than one option.
2. **Secondary tier** — one pill per *stamp/edition* variant *within* the active finish: `Standard | Poké Ball | Master Ball | Shadowless | 1st Edition` etc. Rendered only when the active finish has more than one variant.

A stamp (`POKE_BALL_PATTERN`, `MASTER_BALL_PATTERN`, `SHADOWLESS`, `COSMOS_HOLO`, …) and a non-Unlimited edition (`FIRST_EDITION`) are **never** peers of a finish in the primary row.

## Why this exists

Phase 3a/3b printings work (commits `bd69f40`, `a6a344b`, 2026-04-23) deliberately split `card_printings` so a Pokéball-pattern reverse holo can carry a different price than a standard reverse holo. The data model was correct, but the picker rendered every printing as a flat peer pill — producing rows like `Regular · Pokéball · Masterball · Pokéball · Reverse Holo`, with two pills that literally read "Pokéball" because the stamp text shadowed the finish text in the label resolver.

The fix puts stamps under their parent finish in a secondary tier so the data granularity stays accessible without duplicating labels.

## Where it's wired

| Layer | File | Notes |
|---|---|---|
| Shared shape | [lib/cards/detail-types.ts](../lib/cards/detail-types.ts) | `FinishGroup`, `FinishStampVariant` |
| Grouping logic | [lib/cards/detail.ts](../lib/cards/detail.ts) | `buildFinishGroups(rows)` — single source of truth for ordering, labels, default selection |
| Stamp labels | [lib/cards/detail.ts](../lib/cards/detail.ts) | `stampPillLabel` — explicit cases for Poké Ball, Master Ball, Shadowless |
| Web picker | [components/finish-variant-picker.tsx](../components/finish-variant-picker.tsx) | Renders primary + conditional secondary |
| Web call sites | [components/market-summary-card-client.tsx](../components/market-summary-card-client.tsx), [components/card-detail-instruments.tsx](../components/card-detail-instruments.tsx) | Both use `<FinishVariantPicker>` — never roll your own |
| iOS grouping | [ios/PopAlphaApp/CardService.swift](../ios/PopAlphaApp/CardService.swift) | `Array<CardPrintingOption>.toFinishGroups()` — port of the TS rules. Keep in lockstep. |
| iOS picker | [ios/PopAlphaApp/CardDetailView.swift](../ios/PopAlphaApp/CardDetailView.swift) | `finishPillSection` |

## Default-selection rules

`buildFinishGroups` chooses the default printing for each finish group:

1. The first variant where `stamp == null && edition == "UNLIMITED"` (the "Standard" entry).
2. Falls back to the first variant in the group when no Standard exists (e.g. a finish that only has stamped variants).

When the user clicks a *primary* pill, jump to that group's `defaultPrintingId`. When the user clicks a *secondary* pill, set the printing directly. `?printing=<id>` URL deep links override everything.

## Edge cases the picker already handles

- **Card with one printing only** — picker is hidden entirely.
- **Finish with only stamped variants (no Standard)** — secondary tier shows only the stamps; default is the first stamp.
- **`FIRST_EDITION` + stamp** — combined label `1st Ed · Poké Ball`. Pure 1st Edition (no stamp) becomes a `1st Edition` entry in the secondary tier.
- **`COSMOS_HOLO` and other holo-pattern stamps** — same shape as POKE_BALL_PATTERN; live in secondary tier under Holo.
- **`UNKNOWN` finish** — sorted last, label `Variant`.

## When you add a new stamp / pattern / edition

1. Add the explicit case to `stampPillLabel` (TS) **and** `CardPrintingOption.stampLabel` (Swift). The default fallback uses title-case which can produce ugly results like `"Poke Ball Pattern"` — explicit cases keep the picker text clean.
2. If it's a new edition value (rare — historically only `UNLIMITED` and `FIRST_EDITION`), extend the `EditionKind` type and the Swift `canonicalEdition` switch.
3. Verify on a card that has the new stamp via `/c/<slug>?printing=<new-printing-id>`. The secondary tier should render it.

## Don't reintroduce flat pills

Whenever you touch raw-mode variant rendering, do **not** write new code that does `printings.map((p) => <button>{p.someLabel}</button>)`. Use `<FinishVariantPicker finishGroups={…} selectedPrintingId={…} onChange={…} />`. If a label resolver returns the stamp text instead of the finish text (the original bug), it will produce duplicate pills the moment a card has the same stamp under two finishes.

## Verification matrix (run these before shipping picker changes)

| Card | URL | Expected primary | Expected secondary |
|---|---|---|---|
| Riolu (Prismatic Evolutions) | `/c/prismatic-evolutions-50-riolu` | `Regular`, `Holo`, `Reverse Holo` | Reverse Holo active: `Standard`, `Master Ball`, `Poké Ball`. Holo active: `Master Ball`, `Poké Ball`. |
| Base Charizard | `/c/base-4-charizard` | `Holo` (only) | `Standard`, `Shadowless` |
| Plain modern Common (no stamps) | any sv-era Common | `Regular`, `Reverse Holo` | hidden |
| Single-printing promo | any standalone promo slug | hidden entirely | — |

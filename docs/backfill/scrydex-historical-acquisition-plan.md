# Scrydex Historical Acquisition Plan

As of March 17, 2026, the goal is:

- capture one true RAW price point per card per calendar day
- reach at least 30 daily points in the trailing 30-day window
- reach at least 90 daily points in the trailing 90-day window
- stay under the Scrydex budget cap of 50,000 credits per month

## Verified Capability Check

### Scrydex has two useful paths

- Full-set capture:
  - `GET /pokemon/v1/en/expansions/{id}/cards?page=<n>&page_size=100&include=prices`
- True historical card history:
  - `GET /pokemon/v1/cards/{cardId}/price_history?days=90`

What that means:

- the expansion-cards endpoint is the cheap daily collector
- the card `price_history` endpoint is the retrospective backfill source
- replay of retained raw payloads is still useful, but it is no longer the only way to recover prior days

### Pagination and set size are now exact

Live API verification for `sv3pt5`:

- page `1`: `100` cards
- page `2`: `100` cards
- page `3`: `7` cards
- full daily set capture cost: `3` requests

### Historical backfill is real, but more expensive

Live API verification for `sv3pt5-7`:

- `price_history?days=90` returned `85` dated rows
- date range returned: `2025-12-17` through `2026-03-17`
- Scrydex charges `3` credits per card-history request

### The implementation is now in place

Completed in code:

- Scrydex client support for the card `price_history` endpoint
- a dedicated Scrydex historical backfill path that writes true `snapshot` rows into `price_history_points`
- a cron route to run hot-set capture + history backfill
- day-based coverage reporting that counts distinct calendar days instead of raw timestamps

Live production result for `sv3pt5` on March 17, 2026:

- matched cards fetched from history: `204`
- historical credits used: `612`
- true snapshot rows written: `25,762`
- first error: `null`

## Current State After The Live Backfill

### Raw retention is still short

Current retained Scrydex expansion-card payloads for `sv3pt5` in Postgres:

- `20` successful payloads
- date range: `2026-03-06` through `2026-03-17`
- only `7` distinct fetch days are recoverable from raw replay

That is enough for recent replay, but not enough to satisfy a 90-day requirement by itself.

### 151 / Squirtle is much better, but not fully solved

For `151-7-squirtle` after the live `sv3pt5` historical backfill:

- canonical live distinct days:
  - `28` in the trailing 30 days
  - `85` in the trailing 90 days
- true snapshot days for both matched printings:
  - `24` in the trailing 30 days
  - `81` in the trailing 90 days

So the set-level backfill worked, but Squirtle still does not meet the strict business requirement of one true daily point for every day in the window.

### Exact missing historical dates for Squirtle

Expected 90-day calendar window for March 17, 2026:

- `2025-12-18` through `2026-03-17`
- expected days in window: `90`

What Scrydex itself returns for `sv3pt5-7`:

- dated history rows in that window: `84`
- usable near-mint RAW days for Squirtle normal: `81`
- usable near-mint RAW days for Squirtle reverse holo: `81`

Dates missing entirely from Scrydex history:

- `2026-01-15`
- `2026-01-16`
- `2026-01-17`
- `2026-02-28`
- `2026-03-01`
- `2026-03-03`

Dates present in Scrydex history, but without a usable near-mint RAW price for Squirtle:

- `2026-02-27`
- `2026-03-02`
- `2026-03-04`

Important conclusion:

- Scrydex alone can currently give Squirtle `81` true daily snapshot days in the trailing 90
- the remaining `9` days cannot all be recovered from the current strict near-mint RAW Scrydex path alone

## Budget Reality

### Daily capture is cheap enough

Current mapped Scrydex footprint:

- `192` provider sets
- `347` full-page requests for one complete daily sweep
- about `10,410` requests for a 30-day complete daily sweep

That is comfortably below the monthly cap of `50,000`.

### Full retrospective history for everything is not cheap enough

Current matched Scrydex catalog:

- `22,059` matched provider cards
- one full 90-day history pull across all matched cards would cost `66,177` credits

That exceeds the `50,000` monthly cap, so the retrospective fill must be phased.

### The default hot-set plan fits

Current hot-set planner result with `maxCredits=3000` and `hotSetLimit=10`:

- selected set count: `8`
- total historical credits: `3,000`
- total daily capture requests for those sets: `16`

Selected sets right now:

- `sv3pt5`
- `me2pt5`
- `sv10`
- `sv9`
- `tcgp-PB`
- `mep`
- `base1`
- `fut20`

## Retention Policy Gap

The retention policy is still incomplete for a real 90-day replay guarantee.

What exists:

- raw payload JSON retained in Postgres
- lineage metadata retained in Postgres

What is still missing:

- archive writer for old `provider_raw_payloads.response`
- re-hydrate/replay path from object storage back into normalize and timeseries

Implication:

- a `30`-day Postgres retention target is not enough to support a 90-day historical replay guarantee on its own
- until archive + re-hydrate exists, raw JSON purge should not be treated as safe for this Scrydex history goal

## Narrowest New Fetch / Replay Job

The narrowest job that materially improves coverage is:

1. For each hot set, fetch the full set once per day using the exact page count.
2. For each hot set, run a one-time per-card `price_history?days=90` backfill.
3. Replay retained raw payloads for the same set when needed, with no extra Scrydex spend.
4. Measure success by distinct daily `snapshot` coverage per card, not raw row count.

For `sv3pt5`, that means:

- daily collector cost: `3` requests/day
- one-time historical backfill cost: `612` credits

## Plan To Fill The Previous 90 Days

### What we can do immediately

1. Run the new historical backfill for the hot-set list under a fixed credit budget.
2. Keep daily full-page capture turned on for those same hot sets.
3. Track exact missing calendar dates per card after backfill, not just percentages.

This gets us as much true history as Scrydex is willing to expose while staying inside budget.

### What Scrydex alone cannot solve today

For cards like Squirtle, there are two different residual gap types:

- no Scrydex history row exists for that calendar day
- a history row exists, but it has no usable near-mint RAW price

Those are not the same problem, and they need different policies.

### The clean decision we still need

If the product requirement is truly "a price point for every card every day right now," we need one explicit fallback policy for remaining historical gaps.

Options:

- `strict Scrydex RAW only`
  - leave those dates blank
  - cheapest and cleanest provenance
  - does not satisfy the "every day" requirement for cards like Squirtle today

- `best available Scrydex RAW fallback`
  - when history exists but no near-mint RAW is present, use the best available raw condition and tag it as a fallback
  - this can recover dates like `2026-02-27`, `2026-03-02`, and `2026-03-04`
  - still does not solve dates missing entirely from Scrydex history

- `secondary source or synthetic carry-forward`
  - use another provider, or carry forward the prior day's value with an explicit non-provider provenance tag
  - this is the only way to fill dates like `2026-01-15`, `2026-01-16`, `2026-01-17`, `2026-02-28`, `2026-03-01`, and `2026-03-03` immediately

## Recommended Rollout

### Phase 1: Finish hot-set historical backfill

- keep `sv3pt5` done
- run the same historical backfill for the remaining selected hot sets under the `3,000` credit cap

### Phase 2: Keep daily full-page hot-set capture running

- one run per day
- exact page count per set
- no page-1-only warmups

### Phase 3: Fill the remaining historical holes explicitly

- if strict provenance wins, accept that some cards will remain below 90 true daily points until those missing dates age out of the rolling window
- if "every day" wins, implement a fallback lane for:
  - best available raw condition when Scrydex history exists
  - secondary-source or synthetic carry-forward when Scrydex history does not exist

### Phase 4: Make 90-day replay durable

- archive raw payload JSON after day `30`
- implement object-storage re-hydrate/replay
- only then normalize raw-payload purge as a steady-state policy

## Decision

The question is no longer whether Scrydex has historical data.

It does.

The real decision is:

- use Scrydex `price_history` to backfill as much true history as possible for hot sets now
- keep daily full-page capture running because the forward cost is cheap
- choose an explicit fallback policy for the remaining dates that Scrydex does not provide as strict near-mint RAW history

That is the shortest path to stop hovering and start closing the 90-day gap card by card.

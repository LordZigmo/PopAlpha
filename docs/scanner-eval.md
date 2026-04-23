# Scanner Eval Harness

A reproducible ground-truth test set for `/api/scan/identify` so every change
— crop tweak, threshold adjustment, detector swap, fine-tuned embedder —
is measured end-to-end instead of eyeballed against a handful of ad-hoc scans.

## The two tables

- **`public.scan_eval_images`** — the labeled corpus. One row per
  (image file, known-correct `canonical_slug`) pair. Images themselves
  live in the `card-images` Storage bucket under `scan-eval/<sha256>.jpg`.
- **`public.scan_eval_runs`** — the score history. One row per invocation
  of the eval runner. Carries model version, thresholds, aggregate metrics,
  per-set/per-source breakdowns, and `detailed_results` (per-image outcomes)
  as JSONB so you can diff across runs.

Both tables are service-role only (RLS enabled, no policies). No end-user
read path.

## Seeding

Take a photo of a card you own, label it with its `canonical_slug`, upload:

```bash
npm run eval:seed -- \
  --image ~/Pictures/charizard-ex.jpg \
  --slug 151-183-charizard-ex \
  --source user_photo \
  --language EN \
  --notes "held by top corners, kitchen lighting"
```

Flags:

| Flag | Required | Values | Notes |
|---|---|---|---|
| `--image <path>` | yes | path to JPEG | Magic-byte-checked; HEIC/PNG are rejected. Convert first. |
| `--slug <slug>` | yes | `canonical_cards.slug` | Validated against the table — typos fail fast. |
| `--source <kind>` | no, default `user_photo` | `user_photo` / `telemetry` / `synthetic` / `roboflow` | How the image came to exist. |
| `--language <EN\|JP>` | no, default `EN` | — | Which language slice of the catalog to test against. |
| `--notes "<text>"` | no | — | Free-form; worth writing the capture condition. |
| `--created-by <name>` | no | — | Optional operator tag. |

Same bytes scanned twice = same hash = upsert, not duplicate. Re-seeding to
correct a label or add notes is safe.

## Running an eval

```bash
npm run eval:run
```

Defaults: point at `https://popalpha.ai`, run every image in the corpus,
throttle 300ms between requests.

Useful flags:

```bash
# local dev server
npm run eval:run -- --endpoint http://localhost:3000

# annotate the run so the history is readable
npm run eval:run -- --notes "crop padding -2% + high-conf threshold 0.35"

# slice
npm run eval:run -- --language EN --sources user_photo,synthetic
```

Output is a human-readable per-image log + summary to stdout, and one row
in `scan_eval_runs` with everything including `detailed_results` for
forensic drill-down. Each run auto-diffs against the previous run on the
same endpoint so you immediately see whether your change helped.

## Good first eval set

25–50 images covers:

- **Your own cards** in a variety of capture conditions (hand-held, on
  table, various lighting, tilted). `source = user_photo`.
- **At least 2–3 per set** for the sets you care most about so per-set
  accuracy numbers are non-noisy.
- **Tricky pairs**: scan a Charizard ex and a Charizard V of the same
  artwork so the harness measures how well the embedder discriminates
  variants.

Add to it over time. The `scan_eval_images` table accepts new rows any
time; the runner picks up whatever's there at run time.

## Telemetry isolation

The runner sends `X-PA-Client-Platform: scanner-eval` on every request.
That tag lands in `scan_identify_events.client_platform`, so dashboards
over real-user scan data can filter eval traffic out.

## What this is NOT

- **Not** a CI gate. Runs are manual. A failing run reports metrics but
  doesn't block deploys.
- **Not** a labeling UI. Stage B of the scanner roadmap builds a small
  admin page that walks through medium-confidence `scan_identify_events`
  and lets you click the correct match — that's how the corpus grows
  past what you're willing to photograph manually.
- **Not** a training pipeline. This is the ruler, not the model.

# Scanner runbook

Operational reference for the PopAlpha card scanner. Living
companion to `scanner-zero-tap-sprint.md` (sprint history) and
`scanner-siglip-deployment-options.md` (infra-decision history).
This doc focuses on *running* the scanner: architecture, monitoring,
rollback, troubleshooting.

## Architecture (2026-05-01)

```
┌──────────────┐  JPEG  ┌───────────────────┐  embed  ┌─────────────────┐
│  iOS app     │───────▶│ Vercel route      │────────▶│ Modal SigLIP-2  │
│ (ScannerView)│        │ /api/scan/identify│  HTTPS  │  (T4, snapshots)│
└──────┬───────┘        │                   │         └─────────────────┘
       │                │   Path A/B/C      │
       │                │   routing logic   │
       │                │                   │  pgvector kNN
       │                │                   │────────▶┌────────────────┐
       │                │                   │         │ Supabase       │
       │      response  │                   │         │ card_image_    │
       └◀───────────────┤                   │◀────────│ embeddings     │
                        └───────────────────┘         │ (~46k rows:    │
                                                      │  CLIP + SigLIP │
                                                      │  coexist)      │
                                                      └────────────────┘
                        After response:
                        ┌───────────────────┐
                        │ scan_identify_    │  events log: confidence,
                        │  events           │  winning_path, model_version,
                        │  (Supabase)       │  ocr_card_number, ocr_set_hint
                        └───────────────────┘
```

**Key files:**
- `app/api/scan/identify/route.ts` — the route. Path A/B/C routing.
- `lib/ai/image-embedder.ts` — `ImageEmbedder` interface, factory,
  `ReplicateClipEmbedder` and `ModalSiglipEmbedder` impls.
- `lib/ai/card-image-embeddings.ts` — pgvector schema + kNN insert
  helpers.
- `lib/ai/user-correction-embedding.ts` — v1.1 auto-learning helper.
- `cog/siglip-features/modal_app.py` — Modal SigLIP service.
- `cog/siglip-features/reembed_catalog.py` — local Mac re-embed
  script, used at backbone-swap time.
- `ios/PopAlphaApp/OCRService.swift` — on-device OCR
  (`extractCardIdentifiers` returns `(cardNumber, setHint)`).
- `ios/PopAlphaApp/ScannerTabView.swift` — capture + identify glue.
- `ios/PopAlphaApp/ScanPickerSheet.swift` — medium-confidence
  picker + search-correction flow.

## Production state

**Active embedder:** Modal-hosted SigLIP-2-base-patch16-384.

**Vercel env vars** (production):
- `IMAGE_EMBEDDER_VARIANT=modal-siglip` — selects the embedder
- `MODAL_SIGLIP_ENDPOINT_URL=https://zachdavis710--predict.modal.run`
- `MODAL_SIGLIP_TOKEN=<32-byte hex>` (must match the Modal Secret
  `siglip2-features-token`'s `MODAL_INFERENCE_TOKEN` value)
- `REPLICATE_API_TOKEN`, `REPLICATE_CLIP_MODEL_VERSION` — kept set
  so rollback to CLIP is just an env var swap

**Database tables that drive scanner behavior:**
- `canonical_cards` (Supabase) — slug, name, set_name, card_number,
  card art URL. Source of truth for "what's in the catalog."
- `card_image_embeddings` (Supabase via @vercel/postgres) — pgvector
  rows. PK = `(canonical_slug, variant_index, crop_type, model_version)`
  so CLIP and SigLIP coexist for the same logical card.
- `scan_identify_events` (Supabase) — telemetry. Every scan logs
  here with full context: OCR fields, winning_path, confidence,
  model_version, top match + similarity + gap.
- `scan_eval_images` (Supabase) — labeled corpus. Sources:
  `user_photo` (admin EvalSeedingView), `user_correction` (real-
  device correction flow), `telemetry` (auto-promoted), `synthetic`,
  `roboflow`.

## Monitoring

**Real-time scan health** (run in Supabase SQL editor):

```sql
-- Last hour of production scans, grouped by outcome
SELECT
  to_char(date_trunc('minute', created_at), 'HH24:MI') AS minute,
  confidence,
  winning_path,
  COUNT(*) AS scans
FROM scan_identify_events
WHERE created_at > NOW() - INTERVAL '1 hour'
  AND COALESCE(client_platform, '') NOT IN ('scanner-eval', 'deploy-probe', 'cutover-probe', 'cutover-probe-real-img')
GROUP BY minute, confidence, winning_path
ORDER BY minute DESC, scans DESC;
```

**Path distribution** (which retrieval path is firing — if Path B
isn't firing, OCR may be broken):

```sql
SELECT
  winning_path,
  COUNT(*) AS scans,
  ROUND(100.0 * SUM(CASE WHEN confidence='high' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_high
FROM scan_identify_events
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND COALESCE(client_platform, '') = 'ios'
GROUP BY winning_path;
```

**Modal cost / health:** dashboard at
https://modal.com/apps/zachdavis710/main/deployed/siglip2-features
shows active container count, GPU-seconds, recent invocations
with logs.

**v1.1 anchor growth** (does the auto-learning cache still compound?):

```sql
SELECT
  source,
  COUNT(*) AS embeddings,
  COUNT(DISTINCT canonical_slug) AS distinct_slugs
FROM card_image_embeddings
WHERE model_version = 'siglip2-base-patch16-384-v1'
GROUP BY source;
```

If `user_correction` row count grows over time, the auto-learning
flow is working. If not, check that `/api/admin/scan-eval/promote`
is still being hit by user corrections (look at `scan_eval_images`
INSERT cadence).

## Rollback procedures

### Rollback SigLIP → CLIP (~3 min)

If SigLIP misbehaves in ways CLIP didn't:

```bash
cd /Users/popalpha/Documents/PopAlpha

# 1. Flip the variant env var on Vercel
npx vercel env rm IMAGE_EMBEDDER_VARIANT production
# (or set to "clip")

# 2. Trigger a redeploy from main
git commit --allow-empty -m "Rollback to CLIP embedder"
git push origin main
```

The route's KNN_QUERY filters by `model_version`, so once the env
var is dropped, scans go back to reading the CLIP rows (still in
`card_image_embeddings`). No data migration needed.

CLIP rows can be safely pruned after 30 days of stable SigLIP
production with no rollbacks.

### Rollback the Modal endpoint without rolling back to CLIP

If only the Modal infra is sick (rare — Modal has fewer moving
parts than Replicate's queue) but SigLIP is still the right model,
push a different inference backend by either:
- Re-deploying the Cog model on Replicate's paid "Deployment" tier
  (~$130/mo always-warm) and pointing
  `REPLICATE_CLIP_MODEL_VERSION` at it, then setting
  `IMAGE_EMBEDDER_VARIANT=clip` (this re-uses the existing
  `ReplicateClipEmbedder` since the API contract is identical).
- Standing up a self-hosted SigLIP on the gaming PC (deferred plan
  in `project_scanner_self_hosted_failover.md`).

## Common troubleshooting

### "Embedder failure: Modal endpoint 500: Internal Server Error"

Modal returned an unhandled Python exception. Check Modal's logs at
the dashboard URL above. Known cases:

- **Tiny / grayscale / malformed image**: the SigLIP image processor
  in transformers 4.49 has a channel-detection bug that crashes on
  1-channel images. Real iOS scans (RGB JPEGs) don't hit this; the
  health-check probe with a 1x1 stub does. If you see this in
  production logs, look at the calling client to see what they're
  uploading.
- **Container OOM**: T4 has 15GB VRAM. Batch-size 16 of 384px images
  is fine. If we ever raise batch size, watch for OOMKilled.

### Scans return `vision_only` even though OCR worked

Possible causes:

- Path A short-circuited: the `set_hint` produced by `pickSetHint`
  doesn't match any canonical_cards row's `set_name`. This is
  expected for many cards (most modern Pokémon cards don't print the
  set name on the front). Path B should fire as the fallback.
- Path B short-circuited: the `card_number` filter found 0 rows in
  the kNN top-K (kNN-recall failure) OR found > 3 (too noisy).
  Both fall through to vision_only by design.

To diagnose, look at the row in `scan_identify_events`. The
`ocr_card_number` and `ocr_set_hint` columns show what iOS sent;
the `winning_path` and `top_match_slug` show how the route resolved
it.

### HIGH-confidence scans returning the wrong card

Three classes of trust-killer were patched during the sprint. If a
new one appears, look at which path fired:

- `vision_only` HIGH wrong: probably the OCR-disagreement-demote
  guard didn't fire. Check that `ocr_card_number` is populated AND
  no kNN candidate had a matching number — if so, the demote should
  have engaged. Bug if not.
- `ocr_intersect_unique` HIGH wrong: Path B's intersection picked
  one slug but it wasn't the user's card. The trust-killer
  demote (commit `0db9261`) catches this when the survivor isn't
  CLIP's original top-1; check that the demote is firing.
- `ocr_direct_unique` HIGH wrong: Path A unique false-positive.
  Either iOS sent garbage `set_hint` (transformers 4.49 + lighthouse
  Samurott class — fixed in commit `e3583a3`) OR `canonical_cards`
  has stale data. Use the image_hash to pull the actual scan from
  `scan-uploads/<hash>.jpg` and inspect.

### Modal cold-start latencies > 30s

The `enable_memory_snapshot=True` flag makes cold starts ~3-5s. If
you see >30s, check:
- Modal dashboard: is a snapshot present? (visible in the
  deployment metadata).
- Did the model image get nuked from Modal's GPU cache? (rare,
  ~weekly). First request after eviction triggers a full image
  pull, ~30-60s. Subsequent are fast.

If chronic >10s cold starts, bump `keep_warm` from 0 to 1 in
`modal_app.py` to keep one container always alive (~$72/mo extra).

## Backbone-swap procedure (for future model swaps)

We did one backbone swap during the sprint (CLIP → SigLIP-2). If
we ever need to do another (e.g., SigLIP-2 → SigLIP-3 or
fine-tuned-SigLIP), the procedure is:

1. Add the new model to `IMAGE_EMBEDDER_MODEL_VERSION_*` constants
   in `lib/ai/image-embedder.ts` and a new variant string.
2. Write a new embedder class (or reuse `ModalSiglipEmbedder` if the
   API contract is identical — point at a new Modal endpoint).
3. Update `getImageEmbedder()` factory to handle the new variant.
4. Re-embed the catalog locally on Mac via `reembed_catalog.py`,
   bumping `SIGLIP_MODEL_VERSION` constant in that file. The new
   rows coexist with old rows in `card_image_embeddings` thanks to
   the (..., model_version) PK from migration 20260430030000.
5. Deploy the Modal app for the new model.
6. Smoke test with a real card image via curl.
7. Set the new env vars on Vercel + flip
   `IMAGE_EMBEDDER_VARIANT` to the new variant.
8. Trigger a Vercel redeploy (empty commit + push). Production
   cuts over.
9. Monitor for 24h, ready to flip the env var back if needed.
10. After 30 days stable, optionally prune the old model_version
    rows from `card_image_embeddings`.

The whole procedure is ~3-4 hours active engineering + ~90 min
catalog re-embed wall-time.

## Eval workflow

After any backbone swap, run the local eval to validate:

```bash
cd cog/siglip-features
source venv/bin/activate
python eval_siglip_local.py
```

That script pulls scan_eval_images, embeds each query locally,
runs cosine kNN against the new model_version's catalog rows,
and prints a top-1 / top-5 / per-source scoreboard. Compare to
prior runs in `scanner-zero-tap-sprint.md`.

For production-endpoint eval (using the Modal endpoint instead of
local inference), `npm run eval:run -- --endpoint https://popalpha.ai`
runs the full 277-image scan_eval_runs harness via the production
route. More expensive (~$0.10-1 in Modal compute) but tests the
true end-to-end pipeline.

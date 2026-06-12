# Scanner runbook

Operational reference for the PopAlpha card scanner. Living
companion to `scanner-zero-tap-sprint.md` (sprint history) and
`scanner-siglip-deployment-options.md` (infra-decision history).
This doc focuses on *running* the scanner: architecture, monitoring,
rollback, troubleshooting.

## Architecture (2026-06-12)

```
┌──────────────┐  JPEG  ┌───────────────────┐  embed  ┌─────────────────┐
│  iOS app     │───────▶│ Vercel route      │────────▶│ Home SigLIP-2   │
│ (ScannerView)│        │ /api/scan/identify│  HTTPS  │ (RTX 4070, warm)│
└──────┬───────┘        │                   │ (Funnel)└─────────────────┘
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
- `cog/siglip-features/home_server.py` — self-hosted SigLIP service
  (home GPU via Tailscale Funnel). PRIMARY since 2026-06.
- `cog/siglip-features/modal_app.py` — Modal SigLIP service. RETIRED
  as primary 2026-06 (credit-burn incident); emergency-redeploy
  reference only.
- `cog/siglip-features/reembed_catalog.py` — local Mac re-embed
  script, used at backbone-swap time.
- `ios/PopAlphaApp/OCRService.swift` — on-device OCR
  (`extractCardIdentifiers` returns `(cardNumber, setHint)`).
- `ios/PopAlphaApp/ScannerTabView.swift` — capture + identify glue.
- `ios/PopAlphaApp/ScanPickerSheet.swift` — medium-confidence
  picker + search-correction flow.

## Production state

**Active embedder:** self-hosted SigLIP-2-base-patch16-384 on the
home GPU (RTX 4070), exposed via Tailscale Funnel. Same weights and
`model_version` tag as the retired Modal deployment, so the cutover
needed no catalog re-embed.

**Vercel env vars** (production):
- `IMAGE_EMBEDDER_VARIANT=modal-siglip` — selects the embedder
  class. The home server mirrors the Modal HTTP contract exactly, so
  `ModalSiglipEmbedder` is reused unchanged; the `MODAL_*` names are
  historical and get renamed in the composite-failover PR.
- `MODAL_SIGLIP_ENDPOINT_URL=https://<machine>.<tailnet>.ts.net` —
  the home server's Tailscale Funnel URL.
- `MODAL_SIGLIP_TOKEN=<32-byte hex>` (must match the home server's
  `SIGLIP_INFERENCE_TOKEN` env var)
- `REPLICATE_API_TOKEN`, `REPLICATE_CLIP_MODEL_VERSION` — kept set
  so rollback to CLIP is just an env var swap. NOTE: CLIP rows cover
  only the ~23k EN-era catalog (no JP, no 2026 sets), so that is a
  degraded-mode rollback, not a full failover.

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

## Self-hosted embedder (home GPU) — setup + ops

Primary since 2026-06-12, replacing Modal. Why: the keepwarm cron
(every 4 min) plus `scaledown_window=900` kept Modal's T4 warm 24/7
(~$15/day — the entire $100/mo credit pool in ~7 days, for near-zero
scan traffic); the workspace was then disabled on credit exhaustion
and the server scan path went down silently (~2026-06-07, discovered
06-11). A VRAM-resident local model has no cold starts and no
marginal cost. The keepwarm cron is retired — do not bring it back.

**One-time setup on the PC (Windows, RTX 4070):**

1. Install Python 3.11 (python.org installer, check "Add to PATH").
2. `pip install torch --index-url https://download.pytorch.org/whl/cu124`
   (see https://pytorch.org/get-started/locally/ if the driver wants
   a different CUDA series).
3. `pip install -r cog/siglip-features/home_server_requirements.txt`
4. Generate a token:
   `python -c "import secrets; print(secrets.token_hex(32))"`
   then `setx SIGLIP_INFERENCE_TOKEN <token>` (applies to new shells).
5. `python cog/siglip-features/home_server.py` — first run downloads
   ~750MB of weights; wait for "model loaded", then verify
   `curl http://127.0.0.1:8788/health`.
6. Install Tailscale (same tailnet), enable HTTPS certificates +
   Funnel when prompted (admin console), then:
   `tailscale funnel --bg 8788`
   → note the printed `https://<machine>.<tailnet>.ts.net` URL.
7. Vercel env (production): set `MODAL_SIGLIP_ENDPOINT_URL` to the
   Funnel URL and `MODAL_SIGLIP_TOKEN` to the step-4 token; redeploy
   (empty commit). `IMAGE_EMBEDDER_VARIANT` stays `modal-siglip`.
8. Acceptance: one real smoke scan from the iOS app, then
   `npm run eval:run -- --notes "home GPU cutover"` — expect parity
   with the 2026-05-07 baseline (79.3% default top-1).

**Keep it alive:**
- Power: never sleep (`powercfg /change standby-timeout-ac 0`).
- Task Scheduler: an "At startup" task running
  `python <repo>\cog\siglip-features\home_server.py` (working dir =
  that folder) so reboots and Windows Updates self-heal.
- `tailscale funnel --bg` persists across reboots once set.

**Failure mode:** box or Funnel down → the identify route returns
502 "Embedder failure" and scans fail VISIBLY — no silent fallback,
by design, until the composite-failover PR. Planned follow-up: a
`check-embedder-health` cron probing `/health` hourly that fails
loud. Until it lands, the box has no automated watchdog.

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

**Embedder health:** `GET <funnel-url>/health` (no auth) returns
`{"ok": true, "model_version": ..., "device": "cuda"}`. Request logs
stream to the home server console / Task Scheduler history. The
retired Modal dashboard
(https://modal.com/apps/zachdavis710/main/deployed/siglip2-features)
matters only if the Modal app is ever emergency-redeployed.

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

### Home box down — same-model alternatives

If the home GPU is unreachable (power/ISP/reboot) but SigLIP is
still the right model:
- Run `home_server.py` on any other box — it is GPU-optional
  (~0.5-2s/image on CPU) — and point `MODAL_SIGLIP_ENDPOINT_URL` at
  it. This is also the planned cheap-VM standing fallback.
- Re-deploy the Modal app
  (`modal deploy cog/siglip-features/modal_app.py` — requires
  re-enabling/funding the Modal workspace) and point the env back at
  it. If you do, do NOT re-add a keepwarm cron — that combination is
  what burned the June 2026 credit pool.
- Re-deploying the Cog model on Replicate's paid "Deployment" tier
  (~$130/mo always-warm) also works but is the expensive option.

## Common troubleshooting

### "Embedder failure: ... endpoint 500: Internal Server Error"

The embedder service hit an unhandled Python exception. Check the
home server console / Task Scheduler log (or the Modal dashboard if
the Modal app was emergency-redeployed). Known cases:

- **Tiny / grayscale / malformed image**: the SigLIP image processor
  in transformers 4.49 has a channel-detection bug that crashes on
  1-channel images. Real iOS scans (RGB JPEGs) don't hit this; the
  health-check probe with a 1x1 stub does. If you see this in
  production logs, look at the calling client to see what they're
  uploading.
- **GPU OOM**: the home 4070 has 12GB VRAM; `home_server.py`
  micro-batches at 16, which keeps VRAM flat for arbitrarily long
  input lists. If `MICRO_BATCH` is ever raised, watch VRAM.
  (Modal-era note: T4 had 15GB; batch-16 was fine there too.)

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

### (Retired) Modal cold-start latencies

Cold starts no longer exist on the primary path — the home GPU keeps
the model resident in VRAM. If the Modal app is ever
emergency-redeployed: memory snapshots make cold starts ~3-5s, and
chronic >10s usually means the snapshot is missing. Do NOT "fix"
cold starts with `keep_warm` or a keepwarm cron — a warm T4 bills
the full ~$0.59/hr around the clock (~$425/mo; there is no
discounted idle tier), which is exactly the failure that exhausted
the credit pool and took the scanner down in June 2026.

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
5. Point `home_server.py` at the new model (`MODEL_NAME` /
   `MODEL_VERSION_TAG` constants) and restart it — or deploy a new
   Modal app if cloud-hosting that model instead.
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

For production-endpoint eval (using the live embedder instead of
local inference), `npm run eval:run -- --endpoint https://popalpha.ai`
runs the full scan_eval_runs harness (357 labeled images as of
2026-06, growing via corrections) through the production route —
free on the home GPU, and it exercises the true end-to-end pipeline.

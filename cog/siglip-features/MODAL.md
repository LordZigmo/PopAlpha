# Modal deployment for SigLIP-2 features

Production inference endpoint for the PopAlpha card scanner. Modal
gives us sub-second cold starts (vs Replicate's 3-5 min) at
~$5-10/month with pay-per-use pricing.

## One-time setup

```bash
# Install Modal CLI in your venv (or globally)
cd /Users/popalpha/Documents/PopAlpha/cog/siglip-features
source venv/bin/activate
pip install modal==0.66.0

# Authenticate with Modal (opens browser for OAuth)
modal token new

# Generate a strong random token for the endpoint
python3 -c "import secrets; print(secrets.token_hex(32))"
# Copy the output — you'll use it twice below (once for Modal,
# once for Vercel).

# Create the Modal secret with that token
modal secret create siglip2-features-token \
  MODAL_INFERENCE_TOKEN=<paste-the-token-here>
```

## Deploy

```bash
modal deploy modal_app.py
```

First deploy:
- Builds the Docker image (~5 min)
- Uploads to Modal's registry (~2 min)
- Registers the SigLIPModel class + predict endpoint
- Prints the endpoint URL — looks like:
    `https://<workspace>--siglip2-features-predict.modal.run`

Subsequent deploys (after code changes) only re-upload changed layers
(~30s).

## Verify

```bash
# Smoke test from your machine
curl -X POST <endpoint-url> \
  -H "Content-Type: application/json" \
  -d '{
    "auth": "<your-token>",
    "inputs": "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/151-140-kabuto/full.png"
  }'
```

Expected: `{"results": [{"input": "...", "embedding": [-0.012, ..., 0.008]}], "model_version": "siglip2-base-patch16-384-v1", "took_ms": <number>}`

First call after a fresh deploy may take ~5-10s while the snapshot
restores. Subsequent calls within 5min should return in <1s.

## Wire into the PopAlpha route

Set two Vercel env vars on production:

```bash
npx vercel env add MODAL_SIGLIP_ENDPOINT_URL production
# paste: https://<workspace>--siglip2-features-predict.modal.run

npx vercel env add MODAL_SIGLIP_TOKEN production
# paste: the same token you used in `modal secret create`

npx vercel env add IMAGE_EMBEDDER_VARIANT production
# paste: modal-siglip
```

Then update the `IMAGE_EMBEDDER_MODEL_VERSION` constant in
`lib/ai/image-embedder.ts` from `"replicate-clip-vit-l-14-v1"` to
`"siglip2-base-patch16-384-v1"`. Push.

Vercel redeploys → next /api/scan/identify call hits Modal → SigLIP
catalog rows are now active for kNN.

## Rollback

If anything goes wrong post-cutover:

```bash
# 1. Flip the variant env back to clip
npx vercel env rm IMAGE_EMBEDDER_VARIANT production
# (or set to "clip")

# 2. Revert the IMAGE_EMBEDDER_MODEL_VERSION constant in code
# 3. Push

# Total rollback time: ~3 min Vercel rebuild
```

CLIP rows persist in `card_image_embeddings` indefinitely under
`model_version='replicate-clip-vit-l-14-v1'` — no data migration
needed for rollback. See migration `20260430030000` for the
PK design that makes coexistence possible.

## Cost monitoring

Modal dashboard at https://modal.com/apps/lordzigmo/siglip2-features
shows:
- Active container count (typically 0-1 for our volume)
- Cumulative GPU-seconds
- Daily/monthly spend

Steady state at ~100 scans/day with 5-min idle keep-warm:
- ~30 min/day of warm container time
- 30 × 60s × $0.000725 = $1.30/day
- ~$40/month at this volume

If costs balloon, the scaledown_window in `modal_app.py` controls
how long to keep containers warm after the last request. Lower =
cheaper but more cold starts. Default 300s is sweet spot.

## Local testing

Without deploying, you can run the model locally (Modal pulls the
image to your machine, runs CPU-only):

```bash
modal run modal_app.py
```

Calls the `local_entrypoint` at the bottom of `modal_app.py` which
embeds one card and prints the result. Useful for debugging code
changes before pushing.

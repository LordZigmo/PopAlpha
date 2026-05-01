# cog-siglip-features

Self-hosted Replicate model that extracts SigLIP 2 image embeddings,
exposed via the same `inputs`-newline-separated-URLs API as
`andreasjansson/clip-features`. Drop-in replacement for the
ReplicateClipEmbedder in `lib/ai/image-embedder.ts`.

## Why this exists

The PopAlpha card scanner originally used OpenAI CLIP ViT-L/14 via
`andreasjansson/clip-features` on Replicate. CLIP has a documented
foil-bias failure mode (lighthouse Samurott, V/VMAX confusion) that
SigLIP's sigmoid loss substantially mitigates. SigLIP isn't hosted on
Replicate as a feature extractor (only zero-shot classification), so
we package + push our own.

The base-384 variant was picked deliberately to support the eventual
on-device endgame:
- `siglip2-base-patch16-384` → 768 dim → drops into `vector(768)` schema
- ~92M params → ~180MB CoreML at FP16 → fits in iOS app bundle
- Same model serves Phases 1 (Replicate), 2 (gaming PC), 3 (on-device)

## Deploy

Prereqs:
- Docker Desktop running
- [Cog CLI](https://github.com/replicate/cog) installed: `brew install cog`
- `cog login` (authenticates against Replicate)

Build + push:

```bash
cd cog/siglip-features
cog push r8.im/lordzigmo/siglip2-features
```

The first build downloads ~3GB of CUDA + Torch + the SigLIP weights and
takes 15-20 minutes. Subsequent pushes only re-upload changed layers
(~2-3 minutes).

After push, Replicate gives you a model version hash. Set it as the
`REPLICATE_CLIP_MODEL_VERSION` env var on Vercel (yes, the CLIP-named
var — we'll rename later for clarity).

## Local test

Before pushing, sanity check with:

```bash
cd cog/siglip-features
cog predict -i "inputs=https://replicate.delivery/pbxt/example.jpg"
```

This runs the model in a local Docker container. First run downloads
weights (~5 min). Subsequent runs are fast (~5s including container
spin-up).

For a real card image (which is what you actually want to validate):

```bash
cog predict -i "inputs=$(cat << 'EOF'
https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/card-images/canonical/151-140-kabuto/full.png
EOF
)"
```

Expected output: `[{"input": "...", "embedding": [0.012, -0.034, ...]}]`
with 768 floats. If you see this, the build is good.

## API contract

Input parameter `inputs`:
- Newline-separated list, one image per line
- Each line is either an `http(s)://` URL or a `data:image/jpeg;base64,...` URI
- Whitespace lines are ignored
- Local file paths work in `cog predict` (for testing) but not on the deployed model

Output:
```json
[
  { "input": "https://...", "embedding": [0.012, ..., -0.005] },
  { "input": "data:...",    "embedding": null, "error": "ConnectionError: ..." },
  ...
]
```

- Output is aligned to input order
- Per-input failures emit `{embedding: null, error: "..."}` rather than
  failing the whole batch — same fail-graceful behavior as
  `andreasjansson/clip-features`
- Embeddings are 768-dimensional, L2-normalized, suitable for
  cosine-similarity kNN

## Cost

T4 GPU on Replicate: ~$0.000725/sec while running.
- Setup (cold start): ~5-8s = ~$0.005
- Per-image inference: ~50ms = ~$0.00004
- Batched (50 images): ~500ms = ~$0.00036, or **~$0.000007 per image**

For our 26k catalog re-embed: ~$0.20 if batched well. Or run locally
on a Mac with `transformers` for free (see `scripts/reembed-catalog-siglip.mjs`).

For runtime user scans: ~$0.00004/scan = $40/million scans. Negligible
compared to current CLIP cost (~$0.001/scan).

## When to deprecate

This Cog model is the **Phase 1** inference endpoint. The roadmap:

- **Phase 2** (post-TestFlight, when scan volume justifies infra):
  same model running on user's gaming PC via `cog predict` locally.
  HTTP client switches from Replicate URL to home server URL via env
  var. Same model, same response shape, same code.
- **Phase 3** (v2.0+, on-device offline scanning): convert the same
  HF weights to CoreML via `coremltools`, bundle in iOS app, eliminate
  network dependency entirely.

This Cog repo stays useful indefinitely as the canonical "how do I run
SigLIP 2 features outside iOS?" reference. Don't delete it just because
inference moves on-device.

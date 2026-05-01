# Scanner: SigLIP production-inference deployment options

When the local SigLIP eval validates better accuracy than CLIP, we'll
need a production inference endpoint. Today's `lib/ai/image-embedder.ts`
calls Replicate's `andreasjansson/clip-features`. To use SigLIP we
need *something* that takes an image and returns the 768-dim SigLIP-2
embedding via HTTP.

This doc compares the realistic options. Update as we learn more.

## Status snapshot (2026-04-30)

- ✅ Local SigLIP-2 inference working on Mac MPS (re-embed script)
- ✅ Cog model `lordzigmo/siglip2-features` pushed to Replicate
- ❌ Replicate inference queue stuck — predictions never get past
  `starting` status, no GPU allocation. Cause TBD; could be a
  Replicate-side issue or model deployment config we haven't found.
- ⏸️ Production inference deferred until eval shows SigLIP wins

## Option A: Re-try Replicate after fixing the deploy issue

**Cost:** $0.00004/scan inference + $0 idle. Pay-per-use serverless.
**Setup time:** 0 (already pushed). Just need to figure out why
predictions don't allocate a GPU.

**What to investigate:**
- Replicate dashboard for the model — check "Deployments" tab, look
  for any error messages or "GPU unavailable" status
- Try running a prediction via web playground (UI sometimes provisions
  a GPU when API doesn't, especially for newly-pushed models)
- Open Replicate support ticket if it stays stuck after 30 min
- Check if account-level: is `lordzigmo` a free tier? Some Replicate
  features (private models, dedicated hardware classes) need paid

**Migration if it works:** literally one env var change. The Cog
model's API mirrors `andreasjansson/clip-features` exactly, so our
existing `ReplicateClipEmbedder` works without code changes once
`REPLICATE_CLIP_MODEL_VERSION=<siglip-version>` is set on Vercel.

## Option B: Modal serverless GPUs

Modal is purpose-built for ML inference: fast cold starts (sub-second
with memory snapshots), Python-native deployment, generous keep-warm.

**Cost:** ~$0.0001/sec on T4 + $0 idle (with auto-sleep). For our
volume, ~$5-10/month.
**Setup time:** ~1 hour. Modal CLI install, write a `@app.function`
decorator wrapping our SigLIP load + predict, deploy.

**Pseudocode:**
```python
import modal
app = modal.App("siglip2-features")
image = modal.Image.debian_slim().pip_install("torch", "transformers", "Pillow")

@app.function(gpu="T4", image=image, keep_warm=1)
def embed(image_url: str) -> list[float]:
    # Load model on cold start (cached after)
    # Embed image
    # Return 768-dim L2-normalized vector
    ...
```

**Migration:** new `ModalSiglipEmbedder` class implementing our
`ImageEmbedder` interface; factory in `image-embedder.ts` switches
based on `IMAGE_EMBEDDER_VARIANT=modal-siglip` env var.

**Why I'd lean here if Replicate stays broken:** Modal's cold start
behavior is genuinely better for user-facing inference. Replicate is
optimized for batch jobs.

## Option C: Self-hosted on the gaming PC

Long-term plan from `project_scanner_self_hosted_failover.md`. Deploy
the same Cog model on the gaming PC (just `cog predict` locally on a
machine with NVIDIA), expose via Tailscale or similar.

**Cost:** ~$0 marginal (electricity, ~$3-5/mo).
**Setup time:** ~2 hours: Tailscale install, Cog runtime install,
expose port, circuit-breaker pattern that falls back to Modal/Replicate
when home server is unreachable.

**Migration:** new `LocalGpuEmbedder` class hitting `http://<tailscale>/predict`.
The Cog model's API is unchanged — we'd literally run the same
`r8.im/lordzigmo/siglip2-features` image locally.

**When to do this:** post-TestFlight, when scan volume > ~100/day OR
when monthly Modal cost exceeds the electricity equivalent.

## Option D: HuggingFace Inference Endpoints (dedicated)

Pay for an always-on HF Inference Endpoint — they spin up dedicated
infra for you to host any HF model.

**Cost:** ~$0.06/hr × 24 × 30 = **$43/mo** even idle. Most expensive
of the four.
**Setup time:** ~30 min.

**Why I'd skip this:** the cost-vs-Modal math doesn't work. Modal
gives us pay-per-use with comparable (or better) cold-start behavior
for ~5x less money at our scale.

## Option E: Stay on CLIP forever

If the eval shows SigLIP doesn't meaningfully beat CLIP for our
domain, just don't migrate.

**Cost:** ~$0.001/scan (current Replicate CLIP).
**Setup time:** 0.

**When this might be right:** if SigLIP eval is within ±2pp of CLIP
on our 277-image corpus, the migration cost outweighs the marginal
accuracy gain. The user-correction kNN anchors (v1.1) are already
compounding accuracy improvements; we'd capture most of the gain
SigLIP would provide via natural-corpus growth instead.

---

## Decision tree

```
Run eval_siglip_local.py
  ↓
SigLIP wins by >5pp on real-device or perfect-OCR scenarios?
├── YES → ship to production (try Option A first, fall back to B)
│         ├── Option A works → flip env var, done
│         └── Option A still broken → Option B (1hr Modal setup)
└── NO  → Option E (stay on CLIP)
          Re-eval after natural anchor growth in beta → maybe revisit
```

## Rollback procedure

The migration is designed for instant rollback because CLIP rows
remain in `card_image_embeddings` indefinitely (different model_version,
coexisting via the model_version-inclusive PK from migration
20260430030000).

To roll back from SigLIP → CLIP:

1. **Revert the `IMAGE_EMBEDDER_MODEL_VERSION` constant** in
   `lib/ai/image-embedder.ts`:
   ```ts
   export const IMAGE_EMBEDDER_MODEL_VERSION = "replicate-clip-vit-l-14-v1";
   ```
2. **Revert the `REPLICATE_CLIP_MODEL_VERSION` env var on Vercel** to
   the original `andreasjansson/clip-features` version hash.
3. Push the constant change → Vercel redeploys → next scan queries
   the CLIP row population.

**Rollback latency:** ~3 min Vercel build + 30s propagation.

The reverse (CLIP → SigLIP) is the same procedure with the values
swapped. So the cutover is genuinely two-way.

## What to NOT delete during cutover

Even after a successful SigLIP cutover, keep:
- All `replicate-clip-vit-l-14-v1` rows in `card_image_embeddings`
  (~26k rows, ~80MB — trivial cost, full rollback option)
- The `andreasjansson/clip-features` Replicate model version
  config (env var or comment) for reference

After 30 days of stable SigLIP production with no rollbacks, we
can prune the CLIP rows if storage becomes a concern. Until then,
keep them.

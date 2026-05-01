"""
Modal deployment for SigLIP-2 image feature extraction.

Provides a public HTTP endpoint that mirrors the Cog model's API
(`{"inputs": "url1\\nurl2\\n..."}` → `[{"input": str, "embedding":
list[float] | None, "error"?: str}]`) so the existing Replicate-style
embedder client in lib/ai/image-embedder.ts can be pointed at it
with minimal changes.

Why Modal over Replicate:
    - Memory snapshots → sub-second cold starts (vs Replicate's
      3-5 min for community-tier scale-to-zero models).
    - Pay-per-use (~$0.0001/sec on T4) → ~$5-10/month at our volume
      vs Replicate's $130/month for an always-warm deployment.
    - Container idle timeout configurable; defaults below keep one
      container warm 5min after last request.

Deploy:
    pip install modal==0.66.0
    modal token new                       # one-time auth
    modal deploy cog/siglip-features/modal_app.py

Output: an endpoint URL like
    https://<workspace>--siglip2-features-predict.modal.run

Auth:
    The endpoint reads MODAL_INFERENCE_TOKEN from a Modal Secret named
    `siglip2-features-token`. Create it once with:
        modal secret create siglip2-features-token \\
          MODAL_INFERENCE_TOKEN=<random-hex-32-chars>
    Then set the same value as MODAL_SIGLIP_TOKEN on Vercel so the
    server-side embedder can authenticate.

API contract:
    POST <endpoint>
    Content-Type: application/json
    {
      "auth": "<MODAL_INFERENCE_TOKEN>",
      "inputs": "https://...png\\ndata:image/jpeg;base64,..."
    }

    Response 200:
        {"results": [
            {"input": "https://...", "embedding": [0.012, ..., -0.008]},
            {"input": "data:...",    "embedding": null, "error": "..."}
        ], "model_version": "siglip2-base-patch16-384-v1", "took_ms": 234}

    Response 401: {"detail": "unauthorized"}
    Response 400: {"detail": "..."} — malformed body, etc.

Cost reality (T4 at $0.000725/sec on Modal):
    - Cold start (with snapshot): ~3-5s ≈ $0.002-0.004 each
    - Inference per image: ~50ms ≈ $0.00004 each
    - 5min idle keep-warm: free between calls
    - Steady state at 100 scans/day: <$5/month
"""

import os
from typing import Any

import modal

app = modal.App("siglip2-features")

MODEL_NAME = "google/siglip2-base-patch16-384"
MODEL_VERSION_TAG = "siglip2-base-patch16-384-v1"

# Build the image once. Pre-bake the SigLIP weights into the layer
# so cold starts don't have to download ~600MB of model files.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.3.1",
        "transformers==4.49.0",
        "Pillow==10.4.0",
        "sentencepiece==0.2.0",
        "protobuf==4.25.5",
        "fastapi==0.115.0",
    )
    .run_commands(
        # Pre-download SigLIP-2 weights into the image cache. Use
        # AutoImageProcessor (image-only) to avoid loading the Gemma
        # tokenizer + protobuf surface.
        f"python -c \"from transformers import AutoImageProcessor, AutoModel; "
        f"AutoImageProcessor.from_pretrained('{MODEL_NAME}'); "
        f"AutoModel.from_pretrained('{MODEL_NAME}')\""
    )
)

# Token Secret is created out-of-band (see deploy instructions above).
secret = modal.Secret.from_name("siglip2-features-token", required_keys=["MODAL_INFERENCE_TOKEN"])


@app.cls(
    gpu="T4",
    image=image,
    secrets=[secret],
    # Keep one container warm 5min after last request. The "warm
    # window" trades ~$0.13/hr × idle minutes against the cold-start
    # latency hit on the next request. 5min is the sweet spot for
    # human-paced scanning sessions.
    scaledown_window=300,
    # enable_memory_snapshot lets Modal serialize the loaded model
    # state to disk, then restore it on cold start in ~1-3s vs
    # ~10-30s for fresh model load. Critical for sub-second UX.
    enable_memory_snapshot=True,
    # 30s timeout per request — generous given typical inference is
    # <100ms but allows for download retries on slow URLs.
    timeout=30,
)
class SiglipModel:
    """SigLIP-2 image encoder with snapshot-accelerated cold starts."""

    @modal.enter(snap=True)
    def load_to_cpu(self) -> None:
        """Pre-snapshot setup: load model into CPU memory. Modal
        snapshots this state; subsequent cold starts restore from
        the snapshot instead of re-loading from HF cache."""
        import torch
        from transformers import AutoImageProcessor, AutoModel

        self.processor = AutoImageProcessor.from_pretrained(MODEL_NAME, use_fast=True)
        self.model = AutoModel.from_pretrained(MODEL_NAME).eval()
        # Don't move to CUDA here — snapshots are CPU-only. The
        # @modal.enter(snap=False) hook below moves to GPU after
        # restoration.

    @modal.enter(snap=False)
    def setup_gpu(self) -> None:
        """Post-snapshot setup: move the loaded model to the GPU.
        Runs after Modal restores the snapshot, on the actual GPU
        host. This split is what makes snapshots work — model load
        happens at build time, GPU placement happens at runtime."""
        import torch

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = self.model.to(self.device)

    @modal.method()
    def embed(self, inputs: str) -> list[dict[str, Any]]:
        """Embed each newline-separated URL/data-URI. Returns list
        aligned to input order — failures emit
        {embedding: None, error: '...'} so a single bad URL doesn't
        kill the batch."""
        import base64
        import urllib.request
        from io import BytesIO

        import torch
        from PIL import Image

        sources = [line.strip() for line in inputs.splitlines() if line.strip()]
        if not sources:
            return []

        # Phase 1: load all images, recording per-source errors
        loaded: list[tuple[str, Any, str | None]] = []
        for src in sources:
            try:
                if src.startswith("data:"):
                    comma = src.find(",")
                    if comma < 0:
                        raise ValueError("malformed data URI")
                    payload = src[comma + 1 :]
                    img = Image.open(BytesIO(base64.b64decode(payload))).convert("RGB")
                elif src.startswith("http://") or src.startswith("https://"):
                    req = urllib.request.Request(src, headers={"User-Agent": "modal-siglip"})
                    with urllib.request.urlopen(req, timeout=15) as response:
                        data = response.read()
                    img = Image.open(BytesIO(data)).convert("RGB")
                else:
                    raise ValueError("unsupported source scheme")
                loaded.append((src, img, None))
            except Exception as err:  # noqa: BLE001
                loaded.append((src, None, str(err)[:300]))

        # Phase 2: batch inference
        valid = [(s, i) for s, i, err in loaded if i is not None]
        embeddings_by_src: dict[str, list[float]] = {}
        if valid:
            valid_srcs = [s for s, _ in valid]
            valid_imgs = [i for _, i in valid]
            batch = self.processor(images=valid_imgs, return_tensors="pt").to(self.device)
            with torch.no_grad():
                features = self.model.get_image_features(**batch)
                features = features / features.norm(p=2, dim=-1, keepdim=True)
            for s, e in zip(valid_srcs, features.cpu().tolist()):
                embeddings_by_src[s] = e

        # Phase 3: aligned output
        out: list[dict[str, Any]] = []
        for src, img, err in loaded:
            if img is not None:
                out.append({"input": src, "embedding": embeddings_by_src[src]})
            else:
                out.append({"input": src, "embedding": None, "error": err})
        return out


# ── HTTP endpoint ────────────────────────────────────────────────────
# Modal's fastapi_endpoint exposes a public HTTP URL for the function.
# We add Bearer-token auth via a header check so the endpoint can't
# be hit by random crawlers (cheap protection — for serious abuse we'd
# add Cloudflare WAF in front).

@app.function(
    image=image,
    secrets=[secret],
    timeout=60,
)
@modal.fastapi_endpoint(method="POST", label="predict")
def predict(payload: dict[str, Any]) -> dict[str, Any]:
    """Public HTTP endpoint. Accepts JSON body
    `{"auth": "<token>", "inputs": "url1\\nurl2\\n..."}` and returns
    `{"results": [...], "model_version": "...", "took_ms": ...}`.

    Auth: the `auth` field must match MODAL_INFERENCE_TOKEN from the
    secret. Pragmatic choice over a Bearer header — keeps the endpoint
    simple and doesn't require FastAPI Header dependencies at deploy
    time. This endpoint is server-to-server (Vercel route ↔ Modal),
    not user-facing, so a token-in-body is appropriate. The wire is
    HTTPS so the token isn't sniffable in transit."""
    import time

    from fastapi import HTTPException

    expected = os.environ.get("MODAL_INFERENCE_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="server not configured")

    if payload.get("auth") != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

    inputs = payload.get("inputs")
    if not isinstance(inputs, str):
        raise HTTPException(status_code=400, detail="inputs must be a string")

    started = time.monotonic()
    results = SiglipModel().embed.remote(inputs)
    took_ms = round((time.monotonic() - started) * 1000)

    return {
        "results": results,
        "model_version": MODEL_VERSION_TAG,
        "took_ms": took_ms,
    }


# Local dev: `modal run cog/siglip-features/modal_app.py` to test the
# class without deploying.
@app.local_entrypoint()
def main():
    test_url = (
        "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/"
        "card-images/canonical/151-140-kabuto/full.png"
    )
    out = SiglipModel().embed.remote(test_url)
    item = out[0] if out else None
    if item and item.get("embedding"):
        print(f"OK: dim={len(item['embedding'])}, first 5: {item['embedding'][:5]}")
    else:
        print(f"FAIL: {out}")

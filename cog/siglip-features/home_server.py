"""
Self-hosted SigLIP-2 image feature server — runs on the home GPU
(RTX 4070) and replaces the Modal deployment as the PRIMARY embedder.

Mirrors the Modal endpoint's HTTP contract exactly (see modal_app.py
"API contract") so the Vercel-side `ModalSiglipEmbedder`
(lib/ai/image-embedder.ts) cuts over with an env flip only:

    MODAL_SIGLIP_ENDPOINT_URL=https://<machine>.<tailnet>.ts.net
    MODAL_SIGLIP_TOKEN=<same value as SIGLIP_INFERENCE_TOKEN below>

No TypeScript changes required. (The env names keep their MODAL_
prefix until the planned composite-failover PR renames them.)

Why this exists (2026-06): the Modal setup kept a T4 warm 24/7 for
near-zero traffic — the keepwarm cron fired every 4 min while
scaledown_window was 900s, so the container never slept (~$15/day) —
then the workspace was disabled on credit exhaustion and the server
scan path went down. A model resident in local VRAM has no cold
starts and no marginal cost. Setup + ops: docs/scanner-runbook.md
("Self-hosted embedder").

GPU-optional by design: on a CUDA box it serves from the GPU
(~10-25ms/image on the 4070); on a CPU-only box it still works
(~0.5-2s/image) — the same file is intended to back the future
cheap-VM CPU fallback.

Run (Windows, native Python 3.11):
    pip install torch --index-url https://download.pytorch.org/whl/cu124
    pip install -r home_server_requirements.txt
    setx SIGLIP_INFERENCE_TOKEN <random-hex-32>   # new shells only
    python home_server.py
    # expose publicly:  tailscale funnel --bg 8788

API contract (identical to modal_app.py):
    POST /
    Content-Type: application/json
    {
      "auth": "<SIGLIP_INFERENCE_TOKEN>",
      "inputs": "https://...png\\ndata:image/jpeg;base64,..."
    }

    Response 200:
        {"results": [
            {"input": "https://...", "embedding": [0.012, ..., -0.008]},
            {"input": "data:...",    "embedding": null, "error": "..."}
        ], "model_version": "siglip2-base-patch16-384-v1", "took_ms": 234}

    Response 401: {"detail": "unauthorized"}
    Response 400: {"detail": "..."} — malformed body, etc.
    Response 500: {"detail": "server not configured"} — token env unset.

    GET /health (no auth):
        {"ok": true, "model_version": "...", "device": "cuda"|"cpu"}
"""

import base64
import logging
import os
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from io import BytesIO
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image

MODEL_NAME = "google/siglip2-base-patch16-384"
MODEL_VERSION_TAG = "siglip2-base-patch16-384-v1"

# Modal's T4 ran batch-16 comfortably in 15GB VRAM; the 4070 has 12GB,
# and the embedding crons can send much longer URL lists than the
# identify route's single image — micro-batching keeps VRAM flat
# regardless of request size, with identical output.
MICRO_BATCH = 16
DOWNLOAD_TIMEOUT_S = 15

# Funnel proxies from the local tailscaled, so loopback is enough.
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8788"))

log = logging.getLogger("siglip-home")

_state: dict[str, Any] = {}
# One model on one GPU: serialize forward passes so concurrent
# requests (identify route + a cron tick) can't stack VRAM.
_infer_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    from transformers import AutoImageProcessor, AutoModel

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        log.warning("CUDA not available — serving from CPU (~0.5-2s/image)")
    processor = AutoImageProcessor.from_pretrained(MODEL_NAME, use_fast=True)
    # fp32 to match the Modal deployment's numerics — the catalog rows
    # in card_image_embeddings were produced at fp32.
    model = AutoModel.from_pretrained(MODEL_NAME).eval().to(device)
    _state.update(processor=processor, model=model, device=device)
    gpu = torch.cuda.get_device_name(0) if device.type == "cuda" else "cpu"
    log.info("model %s loaded on %s", MODEL_VERSION_TAG, gpu)
    yield
    _state.clear()


app = FastAPI(lifespan=lifespan)


def _load_image(src: str) -> Image.Image:
    if src.startswith("data:"):
        comma = src.find(",")
        if comma < 0:
            raise ValueError("malformed data URI")
        return Image.open(BytesIO(base64.b64decode(src[comma + 1 :]))).convert("RGB")
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "popalpha-siglip-home"})
        with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as response:
            data = response.read()
        return Image.open(BytesIO(data)).convert("RGB")
    raise ValueError("unsupported source scheme")


def _embed_inputs(inputs: str) -> list[dict[str, Any]]:
    """Same three-phase structure as modal_app.SiglipModel.embed —
    per-source error isolation, batched inference, aligned output."""
    sources = [line.strip() for line in inputs.splitlines() if line.strip()]
    if not sources:
        return []

    loaded: list[tuple[str, Image.Image | None, str | None]] = []
    for src in sources:
        try:
            loaded.append((src, _load_image(src), None))
        except Exception as err:  # noqa: BLE001
            loaded.append((src, None, str(err)[:300]))

    valid = [(s, i) for s, i, err in loaded if i is not None]
    embeddings_by_src: dict[str, list[float]] = {}
    if valid:
        processor = _state["processor"]
        model = _state["model"]
        device = _state["device"]
        with _infer_lock:
            for start in range(0, len(valid), MICRO_BATCH):
                chunk = valid[start : start + MICRO_BATCH]
                batch = processor(images=[i for _, i in chunk], return_tensors="pt").to(device)
                with torch.no_grad():
                    features = model.get_image_features(**batch)
                    features = features / features.norm(p=2, dim=-1, keepdim=True)
                for (s, _), e in zip(chunk, features.cpu().tolist()):
                    embeddings_by_src[s] = e

    out: list[dict[str, Any]] = []
    for src, img, err in loaded:
        if img is not None:
            out.append({"input": src, "embedding": embeddings_by_src[src]})
        else:
            out.append({"input": src, "embedding": None, "error": err})
    return out


@app.post("/")
def predict(payload: dict[str, Any]) -> dict[str, Any]:
    expected = os.environ.get("SIGLIP_INFERENCE_TOKEN") or os.environ.get(
        "MODAL_INFERENCE_TOKEN"
    )
    if not expected:
        raise HTTPException(status_code=500, detail="server not configured")
    if payload.get("auth") != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

    inputs = payload.get("inputs")
    if not isinstance(inputs, str):
        raise HTTPException(status_code=400, detail="inputs must be a string")

    started = time.monotonic()
    results = _embed_inputs(inputs)
    took_ms = round((time.monotonic() - started) * 1000)
    ok_n = sum(1 for r in results if r.get("embedding") is not None)
    log.info("embedded %d/%d inputs in %dms", ok_n, len(results), took_ms)
    return {"results": results, "model_version": MODEL_VERSION_TAG, "took_ms": took_ms}


@app.get("/health")
def health() -> dict[str, Any]:
    device = _state.get("device")
    return {
        "ok": "model" in _state,
        "model_version": MODEL_VERSION_TAG,
        "device": device.type if device is not None else None,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    uvicorn.run(app, host=HOST, port=PORT)

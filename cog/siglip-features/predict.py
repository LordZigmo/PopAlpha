"""
Cog predictor for SigLIP 2 image feature extraction.

API contract (mirrors andreasjansson/clip-features):
    Input  — `inputs`: newline-separated image URLs OR data URIs
                       (data:image/jpeg;base64,...). One source per
                       line. Whitespace ignored.
    Output — list of {"input": <source>, "embedding": list[float] | None,
                      "error": str?}
             Output preserves input order. Per-source failures yield
             {embedding: None, error: "..."} so a single bad URL
             doesn't poison the rest of the batch.

Embeddings are L2-normalized so cosine_similarity(a, b) == dot(a, b).
This matches our existing pgvector index assumption (cosine ops).

Performance:
    - Setup (model load): ~5-8s, runs once per cold start
    - Per-image inference: ~50ms on T4, ~30ms on L4
    - Batch inference (N images): ~50ms + N*~10ms — meaningful batch
      speedup when caller groups requests
"""

import base64
import urllib.request
from io import BytesIO
from typing import Any

import torch
from cog import BasePredictor, Input
from PIL import Image
from transformers import AutoImageProcessor, AutoModel

MODEL_NAME = "google/siglip2-base-patch16-384"


class Predictor(BasePredictor):
    def setup(self) -> None:
        """Load model + image processor into GPU memory once per cold
        start. We use AutoImageProcessor (not AutoProcessor) because
        the predictor only handles images — skipping the SigLIP 2
        tokenizer avoids the protobuf dependency it pulls and keeps
        the cold-start path lean."""
        self.device = torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )
        self.processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
        self.model = AutoModel.from_pretrained(MODEL_NAME).to(self.device)
        self.model.eval()

    def _load_image(self, src: str) -> Image.Image:
        """Resolve URL or data URI into a PIL Image (RGB)."""
        if src.startswith("data:"):
            # data:image/jpeg;base64,<base64>
            comma = src.find(",")
            if comma < 0:
                raise ValueError("malformed data URI")
            payload = src[comma + 1 :]
            return Image.open(BytesIO(base64.b64decode(payload))).convert("RGB")
        if src.startswith("http://") or src.startswith("https://"):
            req = urllib.request.Request(src, headers={"User-Agent": "cog-siglip"})
            with urllib.request.urlopen(req, timeout=15) as response:
                data = response.read()
            return Image.open(BytesIO(data)).convert("RGB")
        # Treat as local path (mainly for `cog predict` local testing).
        return Image.open(src).convert("RGB")

    def predict(
        self,
        inputs: str = Input(
            description=(
                "Newline-separated image URLs or data URIs to embed. "
                "Each line becomes one row in the output."
            ),
        ),
    ) -> list[dict[str, Any]]:
        sources = [line.strip() for line in inputs.splitlines() if line.strip()]
        if not sources:
            return []

        # Phase 1: load all images, collecting per-source errors so a
        # single bad URL doesn't fail the whole batch.
        loaded: list[tuple[str, Image.Image | None, str | None]] = []
        for src in sources:
            try:
                img = self._load_image(src)
                loaded.append((src, img, None))
            except Exception as err:  # noqa: BLE001
                loaded.append((src, None, str(err)[:300]))

        # Phase 2: batch-embed the successful loads. SigLIP processor
        # accepts a list of PIL images and returns a single (N, 3, H, W)
        # tensor. get_image_features then returns (N, 768).
        valid = [(src, img) for src, img, err in loaded if img is not None]
        embeddings_by_src: dict[str, list[float]] = {}

        if valid:
            valid_srcs = [s for s, _ in valid]
            valid_imgs = [i for _, i in valid]
            batch = self.processor(
                images=valid_imgs, return_tensors="pt"
            ).to(self.device)
            with torch.no_grad():
                features = self.model.get_image_features(**batch)
                # L2-normalize so cosine sim == dot product. Important
                # because pgvector's <=> operator computes cosine
                # distance assuming normalized inputs is cleaner.
                features = features / features.norm(p=2, dim=-1, keepdim=True)
            features_list = features.cpu().tolist()
            for src, emb in zip(valid_srcs, features_list):
                embeddings_by_src[src] = emb

        # Phase 3: assemble aligned output.
        output: list[dict[str, Any]] = []
        for src, img, err in loaded:
            if img is not None:
                output.append({"input": src, "embedding": embeddings_by_src[src]})
            else:
                output.append({"input": src, "embedding": None, "error": err})
        return output

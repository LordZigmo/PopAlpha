#!/usr/bin/env python3
"""
Feasibility experiment: convert google/siglip2-base-patch16-384 to
CoreML, validate the converted model produces embeddings indistinguishable
(within tolerance) from the HuggingFace reference, measure model size
and inference latency.

This de-risks the Phase 3 on-device offline scanner work. If conversion
fails or accuracy drops materially, we know before committing to the
~5-day premium-tier implementation.

What we want to learn:
    1. Does the conversion succeed without manual op-level patches?
    2. CoreML model file size (FP16 expected ~185MB, full FP32 ~370MB).
    3. CPU inference latency on this Mac (will be slower than the
       Neural Engine ceiling on iOS, but a useful comparable).
    4. Cosine similarity between HF embedding and CoreML embedding for
       the same input. Target: > 0.9999 (essentially identical).
    5. Whether the SigLIP-2 model has any custom ops coremltools
       refuses to convert.

Output: prints diagnostics + writes the .mlpackage to disk for later
iOS integration.
"""

from __future__ import annotations

import os
import sys
import time
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel

MODEL_NAME = "google/siglip2-base-patch16-384"
OUTPUT_PATH = Path(__file__).parent / "siglip2_base_patch16_384.mlpackage"
TEST_IMAGE_URL = (
    "https://nbveknrnvcgeyysqrtkl.supabase.co/storage/v1/object/public/"
    "card-images/canonical/151-140-kabuto/full.png"
)


def main() -> None:
    print(f"[1/6] Loading HuggingFace model {MODEL_NAME} ...")
    t0 = time.monotonic()
    processor = AutoImageProcessor.from_pretrained(MODEL_NAME, use_fast=True)
    hf_model = AutoModel.from_pretrained(MODEL_NAME).eval()
    print(f"      loaded in {time.monotonic()-t0:.1f}s")

    print(f"[2/6] Downloading test image ...")
    img_resp = requests.get(TEST_IMAGE_URL, timeout=15)
    img_resp.raise_for_status()
    test_image = Image.open(BytesIO(img_resp.content)).convert("RGB")
    print(f"      {test_image.size} {test_image.mode}")

    print(f"[3/6] Computing HF reference embedding ...")
    inputs = processor(images=test_image, return_tensors="pt")
    with torch.no_grad():
        t0 = time.monotonic()
        hf_features = hf_model.get_image_features(**inputs)
        hf_embedding = (hf_features / hf_features.norm(p=2, dim=-1, keepdim=True))
        hf_ms = (time.monotonic() - t0) * 1000
    print(f"      shape={tuple(hf_embedding.shape)} latency={hf_ms:.1f}ms (CPU)")
    hf_vec = hf_embedding.squeeze(0).numpy()
    print(f"      first 5: {hf_vec[:5]}")

    print(f"[4/6] Tracing the vision-encoder path ...")

    # Wrap the model to expose only `get_image_features`. CoreML's
    # converter traces the wrapper, so we control exactly what gets
    # exported — no text encoder, no logit-scale, no classification head.
    class SiglipVisionEmbedder(torch.nn.Module):
        def __init__(self, model: torch.nn.Module) -> None:
            super().__init__()
            self.model = model

        def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
            features = self.model.get_image_features(pixel_values=pixel_values)
            # L2-normalize so cosine similarity == dot product. Matches
            # what reembed_catalog.py and modal_app.py do.
            return features / features.norm(p=2, dim=-1, keepdim=True)

    wrapper = SiglipVisionEmbedder(hf_model).eval()

    example_pixel_values = inputs["pixel_values"]
    print(f"      example pixel_values shape: {tuple(example_pixel_values.shape)}")
    t0 = time.monotonic()
    with torch.no_grad():
        traced = torch.jit.trace(wrapper, example_pixel_values, strict=False)
    print(f"      traced in {time.monotonic()-t0:.1f}s")

    print(f"[5/6] Converting to CoreML ...")
    try:
        import coremltools as ct
    except ImportError:
        print("      coremltools not installed. Run:")
        print("      pip install coremltools==8.1")
        sys.exit(2)

    # SigLIP's normalization: image bytes [0, 255] → [-1, 1]
    # Equivalently: scale = 1/127.5, bias = -1 per channel
    # This bakes preprocessing into the CoreML model so iOS can just
    # hand it a UIImage / CGImage and skip Python preprocessing.
    image_input = ct.ImageType(
        name="image",
        shape=(1, 3, 384, 384),
        scale=1.0 / 127.5,
        bias=[-1.0, -1.0, -1.0],
        color_layout=ct.colorlayout.RGB,
    )

    t0 = time.monotonic()
    try:
        mlmodel = ct.convert(
            traced,
            inputs=[image_input],
            outputs=[ct.TensorType(name="embedding")],
            convert_to="mlprogram",
            compute_units=ct.ComputeUnit.CPU_AND_NE,  # NE on iOS, CPU here
            minimum_deployment_target=ct.target.iOS17,
            compute_precision=ct.precision.FLOAT16,  # FP16 → smaller + faster
        )
    except Exception as err:
        print(f"      CONVERSION FAILED: {type(err).__name__}: {err}")
        print()
        print("      Common causes + fixes:")
        print("      - Custom op without CoreML mapping → may need transformers")
        print("        version bump or a fallback op.")
        print("      - Dynamic shape → the wrapper's forward should be all-static.")
        sys.exit(3)
    convert_s = time.monotonic() - t0
    print(f"      converted in {convert_s:.1f}s")

    print(f"      writing {OUTPUT_PATH} ...")
    mlmodel.save(str(OUTPUT_PATH))

    # Compute size on disk
    if OUTPUT_PATH.is_dir():
        size_bytes = sum(p.stat().st_size for p in OUTPUT_PATH.rglob("*") if p.is_file())
    else:
        size_bytes = OUTPUT_PATH.stat().st_size
    print(f"      .mlpackage size: {size_bytes / (1024 * 1024):.1f} MB")

    print(f"[6/6] Validating CoreML output vs HF reference ...")
    # Convert PIL → numpy uint8 [H, W, 3] for CoreML ImageType input
    # CoreML's ImageType expects a PIL Image directly when computing.
    # Resize to 384x384 to match the model's expected input (matches
    # what the HF processor did).
    test_image_resized = test_image.resize((384, 384), Image.BICUBIC)

    t0 = time.monotonic()
    cm_output = mlmodel.predict({"image": test_image_resized})
    cm_ms = (time.monotonic() - t0) * 1000
    cm_vec = np.asarray(cm_output["embedding"]).squeeze()
    # Re-normalize defensively (the conversion should preserve our
    # in-graph normalization but guard against precision drift).
    cm_vec = cm_vec / np.linalg.norm(cm_vec)
    print(f"      CoreML inference latency: {cm_ms:.1f}ms (Mac CPU/NE — iOS will be faster)")
    print(f"      first 5: {cm_vec[:5]}")

    cosine = float(np.dot(hf_vec, cm_vec))
    l2_diff = float(np.linalg.norm(hf_vec - cm_vec))
    print(f"\n      Cosine similarity (HF vs CoreML): {cosine:.6f}")
    print(f"      L2 distance:                     {l2_diff:.6f}")

    if cosine > 0.9999:
        print(f"\n      ✅ VERDICT: CoreML output matches HF reference. Conversion is production-ready.")
    elif cosine > 0.99:
        print(f"\n      ⚠️  VERDICT: minor drift (likely FP16 quantization). Acceptable for retrieval; verify on more images.")
    elif cosine > 0.95:
        print(f"\n      ⚠️  VERDICT: noticeable drift. May need to use FP32 or investigate which ops are losing precision.")
    else:
        print(f"\n      ❌ VERDICT: significant drift. Conversion has a bug — embeddings would not match catalog.")
        sys.exit(4)

    print(f"\nNext steps:")
    print(f"  1. Validate against 5-10 more images (run with different test URLs).")
    print(f"  2. Measure latency on actual iPhone via Xcode Instruments.")
    print(f"  3. Bundle into iOS app (Resources > {OUTPUT_PATH.name}).")
    print(f"  4. Implement Swift-side embedding via MLModel + image-feature input.")


if __name__ == "__main__":
    main()

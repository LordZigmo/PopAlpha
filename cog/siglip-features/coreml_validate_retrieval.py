#!/usr/bin/env python3
"""
Validate that the CoreML FP16 conversion preserves RETRIEVAL behavior,
not just embedding-level cosine similarity.

The 0.9976 raw cosine similarity from coreml_convert.py tells us the
two embeddings are very close, but with 23k catalog vectors competing,
even small drift could shift top-1 / top-5 in marginal cases.

Test:
    1. Pick 20 cards from scan_eval_images we have ground truth for.
    2. For each, compute the query embedding with BOTH HF and CoreML.
    3. Run kNN against the SigLIP-2 catalog (already in DB) for both.
    4. Report: how often does CoreML's top-1 match HF's top-1?
       And does CoreML's top-1 still match the GROUND-TRUTH slug at
       at least the rate HF does?

If CoreML maintains HF's top-1 in 95%+ of cases, FP16 is shippable.
Otherwise we either upgrade to FP32 (~2x file size) or accept the
gap with explicit messaging in the premium tier UX.
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
from supabase import create_client
from transformers import AutoImageProcessor, AutoModel


MODEL_NAME = "google/siglip2-base-patch16-384"
SIGLIP_MODEL_VERSION = "siglip2-base-patch16-384-v1"
COREML_PATH = Path(__file__).parent / "siglip2_base_patch16_384.mlpackage"


def load_env_local() -> Path | None:
    candidates = [
        Path(__file__).resolve().parent.parent.parent / ".env.local",
        Path.cwd() / ".env.local",
    ]
    for path in candidates:
        if not path.exists():
            continue
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if v and not os.environ.get(k):
                    os.environ[k] = v
        return path
    return None


def main() -> None:
    load_env_local()
    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    print(f"[1/5] Loading HF model + processor ...")
    processor = AutoImageProcessor.from_pretrained(MODEL_NAME, use_fast=True)
    hf_model = AutoModel.from_pretrained(MODEL_NAME).eval()

    print(f"[2/5] Loading CoreML model from {COREML_PATH} ...")
    import coremltools as ct
    cm_model = ct.models.MLModel(str(COREML_PATH))
    print(f"      ready")

    print(f"[3/5] Pulling SigLIP catalog (~23k rows) for kNN ...")
    PAGE = 1000
    rows: list[dict] = []
    cursor = 0
    while True:
        resp = (
            sb.table("card_image_embeddings")
            .select("canonical_slug, set_name, card_number, embedding")
            .eq("model_version", SIGLIP_MODEL_VERSION)
            .eq("crop_type", "full")
            .eq("language", "EN")
            .range(cursor, cursor + PAGE - 1)
            .execute()
        )
        page = resp.data or []
        rows.extend(page)
        if len(page) < PAGE:
            break
        cursor += PAGE
    print(f"      {len(rows)} catalog rows")
    # Parse pgvector text → numpy
    catalog = np.zeros((len(rows), 768), dtype=np.float32)
    for i, r in enumerate(rows):
        emb = r["embedding"]
        if isinstance(emb, str):
            emb = [float(x) for x in emb.strip("[]").split(",")]
        catalog[i] = emb
    # Pre-normalize for cosine = dot
    catalog = catalog / np.linalg.norm(catalog, axis=1, keepdims=True)
    slugs = [r["canonical_slug"] for r in rows]
    print(f"      catalog tensor shape: {catalog.shape}")

    print(f"[4/5] Pulling 20 eval images for retrieval test ...")
    eval_resp = (
        sb.table("scan_eval_images")
        .select("canonical_slug, image_storage_path")
        .eq("captured_language", "EN")
        .order("created_at")
        .limit(20)
        .execute()
    )
    eval_rows = eval_resp.data or []
    print(f"      {len(eval_rows)} eval rows")

    print(f"[5/5] Running both embedders, comparing top-1 ...\n")

    n_hf_correct = 0
    n_cm_correct = 0
    n_top1_match = 0
    n_top5_overlap = 0
    n_attempted = 0

    print(f"  {'idx':>3}  {'expected':<36}  {'HF top-1':<36}  {'CoreML top-1':<36}  match")
    print(f"  {'-' * 130}")

    for idx, row in enumerate(eval_rows, 1):
        expected = row["canonical_slug"]
        try:
            dl = sb.storage.from_("card-images").download(row["image_storage_path"])
            img = Image.open(BytesIO(dl)).convert("RGB")
        except Exception as err:
            print(f"  {idx:>3}  download failed: {err}")
            continue

        # HF embedding
        inputs = processor(images=img, return_tensors="pt")
        with torch.no_grad():
            hf_features = hf_model.get_image_features(**inputs)
            hf_q = (hf_features / hf_features.norm(p=2, dim=-1, keepdim=True)).squeeze(0).numpy()

        # CoreML embedding (resize first since CoreML model expects 384x384 directly)
        img_384 = img.resize((384, 384), Image.BICUBIC)
        cm_out = cm_model.predict({"image": img_384})
        cm_q = np.asarray(cm_out["embedding"]).squeeze()
        cm_q = cm_q / np.linalg.norm(cm_q)

        # kNN: cosine = dot since both are normalized
        hf_sims = catalog @ hf_q
        cm_sims = catalog @ cm_q
        hf_top5_idx = np.argsort(-hf_sims)[:5]
        cm_top5_idx = np.argsort(-cm_sims)[:5]
        hf_top5 = [slugs[i] for i in hf_top5_idx]
        cm_top5 = [slugs[i] for i in cm_top5_idx]

        n_attempted += 1
        if hf_top5[0] == expected: n_hf_correct += 1
        if cm_top5[0] == expected: n_cm_correct += 1
        if hf_top5[0] == cm_top5[0]: n_top1_match += 1
        if len(set(hf_top5) & set(cm_top5)) >= 3: n_top5_overlap += 1

        match_marker = "✓" if hf_top5[0] == cm_top5[0] else "✗"
        print(f"  {idx:>3}  {expected[:36]:<36}  {hf_top5[0][:36]:<36}  {cm_top5[0][:36]:<36}  {match_marker}")

    n = n_attempted
    print(f"\nResults across {n} eval images:")
    print(f"  HF      top-1 vs ground truth: {n_hf_correct}/{n} ({100*n_hf_correct/n:.1f}%)")
    print(f"  CoreML  top-1 vs ground truth: {n_cm_correct}/{n} ({100*n_cm_correct/n:.1f}%)")
    print(f"  HF top-1 == CoreML top-1:      {n_top1_match}/{n} ({100*n_top1_match/n:.1f}%)")
    print(f"  HF top-5 ∩ CoreML top-5 ≥ 3:   {n_top5_overlap}/{n} ({100*n_top5_overlap/n:.1f}%)")

    print(f"\nVerdict:")
    if n_top1_match >= int(n * 0.95):
        print(f"  ✅ FP16 CoreML matches HF top-1 in {100*n_top1_match/n:.1f}% of cases.")
        print(f"     Ship FP16 — drift is below the noise floor for retrieval purposes.")
    elif n_top1_match >= int(n * 0.85):
        print(f"  ⚠️  FP16 disagrees with HF top-1 in {100*(n-n_top1_match)/n:.1f}% of cases.")
        print(f"     Consider re-embedding catalog with CoreML so query and catalog ")
        print(f"     are in the same FP16 space. Or ship FP32 (370MB).")
    else:
        print(f"  ❌ FP16 disagrees with HF too often. Switch to FP32 conversion.")

    if abs(n_cm_correct - n_hf_correct) <= 1:
        print(f"  ✅ CoreML's accuracy vs ground truth ({n_cm_correct}/{n}) effectively matches HF ({n_hf_correct}/{n}).")
        print(f"     The drift, where it exists, doesn't materially hurt retrieval.")


if __name__ == "__main__":
    main()

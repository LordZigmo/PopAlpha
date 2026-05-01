#!/usr/bin/env python3
"""
Local SigLIP eval — validates the SigLIP embedding swap without
needing a production Replicate endpoint.

Pipeline (mirrors what /api/scan/identify will do once SigLIP is
production-deployed, but everything runs locally):
    1. Pull every scan_eval_images row from Supabase (the 277-image
       ground-truth corpus + the 28 user_correction anchors).
    2. For each image: download the JPEG, embed locally with SigLIP 2.
    3. Run a server-side kNN against the SigLIP rows in
       card_image_embeddings (filtered by model_version + crop_type
       + language, same as the route's KNN_QUERY).
    4. Compare top-1 to the labeled canonical_slug. Print a scoreboard
       comparable to scripts/run-scanner-eval.mjs's output.

Pre-requisites:
    - Run reembed_catalog.py FIRST so card_image_embeddings has SigLIP
      rows to query against.
    - Same venv works (transformers 4.49 + torch + supabase-py).

Usage:
    cd cog/siglip-features && source venv/bin/activate
    python eval_siglip_local.py            # full eval
    python eval_siglip_local.py --limit 30  # quick smoke

Output:
    Per-image marker (✓ top-1 / ~ top-5 / ✗ miss)
    Aggregate top-1 / top-5 / per-set breakdown
    Comparison line vs. CLIP baseline (Day 2.5: 81.2% perfect-OCR top-1)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections import Counter
from io import BytesIO
from pathlib import Path

import requests
import torch
from PIL import Image
from supabase import Client, create_client
from transformers import AutoImageProcessor, AutoModel

SIGLIP_MODEL_VERSION = "siglip2-base-patch16-384-v1"
SIGLIP_HF_NAME = "google/siglip2-base-patch16-384"


def load_env_local() -> Path | None:
    """Best-effort load of repo-root .env.local."""
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
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if v and not os.environ.get(k):
                    os.environ[k] = v
        return path
    return None


def pick_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def fetch_eval_images(sb: Client, limit: int | None) -> list[dict]:
    """Pull labeled scan_eval_images rows. Includes both user_photo
    (admin-curated) and user_correction (real-device) sources — the
    full eval corpus."""
    PAGE = 1000
    out: list[dict] = []
    cursor = 0
    while True:
        resp = (
            sb.table("scan_eval_images")
            .select(
                "id, canonical_slug, image_storage_path, captured_source, "
                "captured_language, notes, created_at"
            )
            .order("created_at")
            .range(cursor, cursor + PAGE - 1)
            .execute()
        )
        rows = resp.data or []
        out.extend(rows)
        if len(rows) < PAGE:
            break
        cursor += PAGE
        if limit is not None and len(out) >= limit:
            break
    return out[:limit] if limit is not None else out


def download_eval_image(sb: Client, storage_path: str) -> Image.Image | None:
    """Download from the card-images bucket via the storage REST API
    using service role auth. Public URL would also work but service
    role is more reliable across env."""
    try:
        # storage_path is like "scan-eval/<hash>.jpg"
        parts = storage_path.split("/", 1)
        if len(parts) != 2:
            return None
        prefix, key = parts
        # Use the supabase-py client's storage download
        bucket = sb.storage.from_("card-images")
        data = bucket.download(storage_path)
        return Image.open(BytesIO(data)).convert("RGB")
    except Exception as err:
        print(f"  ! download failed {storage_path}: {type(err).__name__}: {str(err)[:80]}")
        return None


def knn_query_supabase_rpc_unavailable(sb: Client, embedding: list[float], language: str, k: int = 5) -> list[dict]:
    """We don't have a pgvector RPC — call SQL directly via PostgREST
    by inserting the query embedding into a temp expression isn't
    possible through PostgREST. Instead we use the supabase client's
    raw SQL execution via rpc() if a function exists, otherwise
    fall back to fetching all candidates and ranking client-side
    (slow but works for the eval)."""
    raise NotImplementedError("see knn_via_pg_function below")


def knn_via_pg_function(sb: Client, embedding: list[float], language: str, k: int = 5) -> list[dict]:
    """Run kNN by calling a pg function we'll create on the fly via
    rpc(). We can't pass vectors through PostgREST as parameters
    cleanly, so for the eval we instead fetch ALL siglip2 rows and
    do cosine similarity in Python. Slow per-query (~150ms) but
    fine for a 277-image eval (~40s overhead total).

    Trade-off accepted: we want to keep the eval pure-Python /
    no-DB-DDL so the user can run it without admin migrations.
    """
    # This function is called per-query; the catalog gets pulled
    # ONCE by the caller and reused.
    raise NotImplementedError("use the cached catalog approach")


def fetch_siglip_catalog(sb: Client, language: str) -> list[dict]:
    """One-shot pull of every SigLIP catalog row for the language.
    Returns dicts with slug + embedding (parsed from the pgvector
    text representation)."""
    PAGE = 1000
    out: list[dict] = []
    cursor = 0
    while True:
        resp = (
            sb.table("card_image_embeddings")
            .select(
                "canonical_slug, canonical_name, set_name, card_number, "
                "variant, embedding"
            )
            .eq("model_version", SIGLIP_MODEL_VERSION)
            .eq("crop_type", "full")
            .eq("language", language)
            .range(cursor, cursor + PAGE - 1)
            .execute()
        )
        rows = resp.data or []
        out.extend(rows)
        if len(rows) < PAGE:
            break
        cursor += PAGE
    # Parse embedding strings to float lists once. They come back as
    # the pgvector text representation: "[0.1,0.2,...]"
    for row in out:
        emb_str = row["embedding"]
        if isinstance(emb_str, str):
            row["embedding"] = [
                float(x) for x in emb_str.strip("[]").split(",")
            ]
    return out


def cosine_top_k(query: torch.Tensor, catalog_t: torch.Tensor,
                 catalog_rows: list[dict], k: int) -> list[tuple[float, dict]]:
    """Cosine similarity between one query and all catalog vectors.
    Both inputs assumed L2-normalized so cosine == dot product."""
    sims = (catalog_t @ query).cpu().tolist()
    ranked = sorted(zip(sims, catalog_rows), key=lambda x: -x[0])
    return ranked[:k]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--language", default="EN")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    env_path = load_env_local()
    if env_path:
        print(f"[env] loaded {env_path}")

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not sb_url or not sb_key:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
        sys.exit(2)
    sb = create_client(sb_url, sb_key)

    device = pick_device()
    print(f"[device] {device}")
    print(f"[model] loading {SIGLIP_HF_NAME} ...")
    processor = AutoImageProcessor.from_pretrained(SIGLIP_HF_NAME, use_fast=True)
    model = AutoModel.from_pretrained(SIGLIP_HF_NAME).to(device).eval()
    print(f"[model] ready")

    # Pull catalog once. ~22.6k rows × 768 floats × 8 bytes (Python float) =
    # ~140 MB in memory. Fine on any modern Mac.
    print(f"[catalog] pulling SigLIP catalog rows for language={args.language} ...")
    t0 = time.monotonic()
    catalog = fetch_siglip_catalog(sb, args.language)
    print(f"[catalog] {len(catalog)} rows in {time.monotonic()-t0:.1f}s")
    if not catalog:
        print(f"\nNo SigLIP rows under language={args.language}. Run reembed_catalog.py first.")
        sys.exit(1)

    # Pre-stack catalog into one tensor for fast batched cosine.
    catalog_t = torch.tensor(
        [row["embedding"] for row in catalog],
        dtype=torch.float32,
        device=device,
    )
    # L2-normalize (catalog should already be normalized but be defensive)
    catalog_t = catalog_t / catalog_t.norm(p=2, dim=-1, keepdim=True)
    print(f"[catalog] shape={tuple(catalog_t.shape)}")

    eval_rows = fetch_eval_images(sb, args.limit)
    eval_rows = [r for r in eval_rows if r["captured_language"] == args.language]
    print(f"[eval] {len(eval_rows)} eval images for language={args.language}\n")

    n_top1 = 0
    n_top5 = 0
    n_errors = 0
    per_source: dict[str, dict[str, int]] = {}

    for idx, row in enumerate(eval_rows, 1):
        expected = row["canonical_slug"]
        source = row["captured_source"]
        per_source.setdefault(source, {"n": 0, "top1": 0, "top5": 0})
        per_source[source]["n"] += 1

        img = download_eval_image(sb, row["image_storage_path"])
        if img is None:
            n_errors += 1
            print(f"  [{idx:>3}] ERR  {expected[:36].ljust(36)}  download failed")
            continue

        inputs = processor(images=img, return_tensors="pt").to(device)
        with torch.no_grad():
            features = model.get_image_features(**inputs)
            features = features / features.norm(p=2, dim=-1, keepdim=True)
        query = features.squeeze(0)

        top_k = cosine_top_k(query, catalog_t, catalog, args.top_k)
        top1_slug = top_k[0][1]["canonical_slug"]
        top5_slugs = [r["canonical_slug"] for _, r in top_k]
        is_top1 = top1_slug == expected
        is_top5 = expected in top5_slugs
        if is_top1: n_top1 += 1; per_source[source]["top1"] += 1
        if is_top5: n_top5 += 1; per_source[source]["top5"] += 1
        marker = "✓" if is_top1 else ("~" if is_top5 else "✗")
        sim = top_k[0][0]
        print(
            f"  [{idx:>3}] {marker}  sim={sim:.4f}  "
            f"{expected[:36].ljust(36)}  {top1_slug[:36].ljust(36)}"
        )

    print()
    n = len(eval_rows)
    print(f"  Results: {n_top1}/{n} top-1 ({100*n_top1/n:.1f}%) · "
          f"{n_top5}/{n} top-5 ({100*n_top5/n:.1f}%) · "
          f"{n_errors} errors")
    print(f"\n  Per-source breakdown:")
    for src, c in per_source.items():
        if c["n"] == 0:
            continue
        print(f"    {src.ljust(20)}  {c['top1']}/{c['n']} top-1  "
              f"{c['top5']}/{c['n']} top-5")
    print()
    print(f"  CLIP baselines for comparison (from Day 2.5 eval):")
    print(f"    Baseline (no OCR):           48.7% top-1")
    print(f"    Perfect-OCR Path A (CLIP):   81.2% top-1")
    print(f"    Real-device session 4:       70% top-1 raw / 81% with corrections")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Re-embed the card_image_embeddings catalog under SigLIP 2 locally on
your Mac (or any machine with MPS / CUDA). Free (no Replicate spend),
runs in parallel with the Cog push.

What it does:
    1. Pulls every catalog row from Supabase that's currently embedded
       under the legacy CLIP model (model_version='replicate-clip-vit-l-14-v1',
       crop_type='full', variant_index=0).
    2. Downloads each row's source_image_url (Supabase Storage public URL).
    3. Re-embeds the image with google/siglip2-base-patch16-384 on the
       fastest device available (Apple MPS → CUDA → CPU).
    4. Inserts a new row under model_version='siglip2-base-patch16-384-v1',
       same crop_type/variant_index, L2-normalized embedding.

Idempotent: skips rows that already have a SigLIP anchor.
Resumable: re-running picks up where the last interrupt left off.

Usage:
    cd cog/siglip-features
    python -m venv venv && source venv/bin/activate
    pip install -r requirements.txt
    python reembed_catalog.py             # everything
    python reembed_catalog.py --limit 50  # smoke-test against 50 rows first

Env vars (read from .env.local in repo root if present):
    SUPABASE_URL              — required
    SUPABASE_SERVICE_ROLE_KEY — required
"""

# PEP 604 union syntax (`int | None`) requires Python 3.10+. This
# directive makes all annotations lazy strings so they parse on 3.9
# too — useful for users on macOS-stock Python.
from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import requests
import torch
from PIL import Image, UnidentifiedImageError
from supabase import create_client, Client
from transformers import AutoImageProcessor, AutoModel

CLIP_MODEL_VERSION = "replicate-clip-vit-l-14-v1"
SIGLIP_MODEL_VERSION = "siglip2-base-patch16-384-v1"
SIGLIP_HF_NAME = "google/siglip2-base-patch16-384"


def load_env_local():
    """Best-effort load of repo-root .env.local into os.environ."""
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
    """Apple MPS → CUDA → CPU. Prints the choice for clarity."""
    if torch.backends.mps.is_available():
        print("[device] Apple MPS (Metal Performance Shaders)")
        return torch.device("mps")
    if torch.cuda.is_available():
        print(f"[device] CUDA: {torch.cuda.get_device_name(0)}")
        return torch.device("cuda")
    print("[device] CPU (slow — install PyTorch with MPS or CUDA support)")
    return torch.device("cpu")


def fetch_clip_rows(
    sb: Client, source: str, limit: int | None
) -> list[dict]:
    """Pull every CLIP-embedded full-crop row of the given source
    ('catalog' or 'user_correction'). Bounded paging because Supabase
    PostgREST defaults max 1000 rows per request."""
    PAGE = 1000
    out: list[dict] = []
    cursor = 0
    while True:
        q = (
            sb.table("card_image_embeddings")
            .select(
                "canonical_slug, source_image_url, source_hash, language, "
                "set_name, card_number, variant, canonical_name, variant_index"
            )
            .eq("model_version", CLIP_MODEL_VERSION)
            .eq("crop_type", "full")
            .eq("source", source)
            .order("canonical_slug")
            .range(cursor, cursor + PAGE - 1)
        )
        resp = q.execute()
        rows = resp.data or []
        out.extend(rows)
        if len(rows) < PAGE:
            break
        cursor += PAGE
        if limit is not None and len(out) >= limit:
            break
    return out[:limit] if limit is not None else out


def fetch_existing_siglip_keys(sb: Client) -> set[tuple[str, int]]:
    """Set of (slug, variant_index) pairs that already have a SigLIP
    anchor — used to skip on resume. Includes BOTH catalog
    (variant_index=0) and user_correction (>=10000) rows."""
    PAGE = 1000
    out: set[tuple[str, int]] = set()
    cursor = 0
    while True:
        resp = (
            sb.table("card_image_embeddings")
            .select("canonical_slug, variant_index")
            .eq("model_version", SIGLIP_MODEL_VERSION)
            .eq("crop_type", "full")
            .range(cursor, cursor + PAGE - 1)
            .execute()
        )
        rows = resp.data or []
        for row in rows:
            out.add((row["canonical_slug"], row["variant_index"]))
        if len(rows) < PAGE:
            break
        cursor += PAGE
    return out


def resolve_image_url(source_image_url: str, supabase_url: str) -> str:
    """User_correction rows store source_image_url as
    `supabase://card-images/scan-eval/<hash>.jpg`. Convert that to
    the public HTTPS URL the requests library can fetch. Catalog
    URLs already start with https:// so we pass them through."""
    PREFIX = "supabase://card-images/"
    if source_image_url.startswith(PREFIX):
        path = source_image_url[len(PREFIX):]
        return f"{supabase_url}/storage/v1/object/public/card-images/{path}"
    return source_image_url


# Shared requests.Session with a generous connection pool. urllib3's
# default per-host pool is 10; with 8 download threads we'd push to
# the limit and start silently dropping connections under load. A
# session with maxsize=32 and pool_connections=32 fits 8 workers
# comfortably with retry headroom.
_SESSION: requests.Session | None = None


def _get_session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        s = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=32,
            pool_maxsize=32,
            max_retries=2,
        )
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        s.headers.update({"User-Agent": "popalpha-reembed"})
        _SESSION = s
    return _SESSION


def download_image(url: str, timeout: int = 30) -> Image.Image | None:
    """Download via the shared session so urllib3 connection pooling
    works across threads. Two retries handle the SSL_BAD_RECORD_MAC /
    EOF transients that struck the first run."""
    last_err: Exception | None = None
    session = _get_session()
    for attempt in range(3):
        try:
            r = session.get(url, timeout=timeout)
            r.raise_for_status()
            return Image.open(BytesIO(r.content)).convert("RGB")
        except (requests.RequestException, UnidentifiedImageError) as err:
            last_err = err
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
                continue
        except Exception as err:
            last_err = err
            break
    if last_err:
        print(f"  ! download failed {url[:80]}: {type(last_err).__name__}: {str(last_err)[:80]}")
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="Max rows to process (smoke test)")
    parser.add_argument("--batch-size", type=int, default=16,
                        help="Images per forward pass (GPU memory ceiling)")
    parser.add_argument("--download-workers", type=int, default=8,
                        help="Parallel HTTP fetches per batch")
    parser.add_argument("--progress-every", type=int, default=200,
                        help="Print summary every N rows")
    parser.add_argument(
        "--source",
        choices=["catalog", "user_correction", "both"],
        default="both",
        help="Which embedding population to re-embed",
    )
    args = parser.parse_args()

    env_path = load_env_local()
    if env_path:
        print(f"[env] loaded {env_path}")

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not sb_url or not sb_key:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.", file=sys.stderr)
        sys.exit(2)

    sb = create_client(sb_url, sb_key)

    print(f"[model] loading {SIGLIP_HF_NAME} ...")
    device = pick_device()
    # AutoImageProcessor (not AutoProcessor) — image-encoder only,
    # avoids loading SigLIP 2's Gemma tokenizer + protobuf surface.
    # use_fast=True opts into the Rust-backed image processor (faster
    # PIL→tensor preprocessing). Silences the "slow processor" warning
    # and is correct per HF — the slow/fast split is just impl, same
    # outputs.
    processor = AutoImageProcessor.from_pretrained(SIGLIP_HF_NAME, use_fast=True)
    model = AutoModel.from_pretrained(SIGLIP_HF_NAME).to(device).eval()
    print(f"[model] ready on {device}")

    sources_to_run = (
        ["catalog", "user_correction"] if args.source == "both" else [args.source]
    )
    catalog: list[dict] = []
    for src in sources_to_run:
        rows = fetch_clip_rows(sb, src, args.limit)
        print(f"[fetch] {len(rows)} CLIP rows to consider (source={src})")
        for r in rows:
            r["_source"] = src
        catalog.extend(rows)

    print(f"[fetch] pulling existing SigLIP (slug, variant_index) keys (idempotency) ...")
    existing = fetch_existing_siglip_keys(sb)
    print(f"[fetch] {len(existing)} keys already SigLIP-embedded — will skip\n")

    work = [
        r for r in catalog
        if (r["canonical_slug"], r["variant_index"]) not in existing
    ]
    print(f"[plan] {len(work)} rows to embed this run\n")

    n_embedded = 0
    n_skipped = 0
    n_failed = 0
    started_at = time.monotonic()

    # Process in batches for GPU efficiency.
    for batch_start in range(0, len(work), args.batch_size):
        batch = work[batch_start : batch_start + args.batch_size]

        # Phase 1: download all images in parallel. Each row's fetch
        # is independent, so a thread pool gets us ~8x speedup over
        # sequential fetches. Storage server handles the concurrency
        # fine — we're a single client hitting the public CDN.
        def _fetch(row):
            raw = row["source_image_url"]
            if not raw:
                return (row, None)
            url = resolve_image_url(raw, sb_url)
            img = download_image(url)
            return (row, img)

        with ThreadPoolExecutor(max_workers=args.download_workers) as pool:
            loaded = list(pool.map(_fetch, batch))
        for _, img in loaded:
            if img is None:
                n_failed += 1

        valid = [(row, img) for row, img in loaded if img is not None]
        if not valid:
            continue

        # Phase 2: batch forward through SigLIP
        try:
            valid_imgs = [img for _, img in valid]
            inputs = processor(images=valid_imgs, return_tensors="pt").to(device)
            with torch.no_grad():
                features = model.get_image_features(**inputs)
                features = features / features.norm(p=2, dim=-1, keepdim=True)
            embeddings = features.cpu().tolist()
        except Exception as err:
            print(f"  ! batch embed failed: {type(err).__name__}: {err}")
            n_failed += len(valid)
            continue

        # Phase 3: bulk insert the whole batch in one call. Single
        # PostgREST round-trip vs N round-trips is a meaningful win
        # at 22.6k rows. Preserves the original `source` tag so
        # eval/observability views distinguish populations.
        rows_to_insert = []
        for (row, _img), emb in zip(valid, embeddings):
            vec_literal = "[" + ",".join(f"{x:.6f}" for x in emb) + "]"
            rows_to_insert.append({
                "canonical_slug": row["canonical_slug"],
                "canonical_name": row["canonical_name"],
                "language": row["language"],
                "set_name": row["set_name"],
                "card_number": row["card_number"],
                "variant": row["variant"],
                "source_image_url": row["source_image_url"],
                "source_hash": row["source_hash"],
                "model_version": SIGLIP_MODEL_VERSION,
                "embedding": vec_literal,
                "variant_index": row["variant_index"],
                "crop_type": "full",
                "source": row["_source"],
            })

        if rows_to_insert:
            try:
                sb.table("card_image_embeddings").insert(rows_to_insert).execute()
                n_embedded += len(rows_to_insert)
            except Exception as err:
                # ANY batch failure (duplicates, SSL transients, network
                # hiccups) falls back to per-row inserts with a retry
                # loop. Catches the SSL_BAD_RECORD_MAC class of TLS
                # blips that lost 16 rows on the smoke run, AND keeps
                # the duplicate-skip path working.
                print(f"  · batch insert failed ({str(err)[:80]}), falling back to per-row")
                for one in rows_to_insert:
                    landed = False
                    for attempt in range(3):
                        try:
                            sb.table("card_image_embeddings").insert(one).execute()
                            n_embedded += 1
                            landed = True
                            break
                        except Exception as inner:
                            inner_msg = str(inner)
                            if "duplicate key" in inner_msg.lower() or "23505" in inner_msg:
                                n_skipped += 1
                                landed = True
                                break
                            # Transient — back off and retry.
                            if attempt < 2:
                                time.sleep(0.5 * (attempt + 1))
                                continue
                            # Final attempt failed — count and move on.
                            print(f"  ! insert failed slug={one['canonical_slug']}: {inner_msg[:120]}")
                            n_failed += 1
                    if not landed:
                        # Defensive — should be unreachable but keep
                        # totals balanced if it happens.
                        pass

        # Phase 4: progress print
        done = n_embedded + n_skipped + n_failed
        if done % args.progress_every == 0 or batch_start + args.batch_size >= len(work):
            elapsed = time.monotonic() - started_at
            rate = done / elapsed if elapsed > 0 else 0
            remaining = len(work) - done
            eta_min = (remaining / rate / 60) if rate > 0 else float("inf")
            print(
                f"  [{done:>5}/{len(work)}] embedded={n_embedded} skipped={n_skipped} "
                f"failed={n_failed}  rate={rate:.1f}/s  eta={eta_min:.1f}min"
            )

    elapsed = time.monotonic() - started_at
    print(f"\n[done] embedded={n_embedded} skipped={n_skipped} failed={n_failed} "
          f"total_time={elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

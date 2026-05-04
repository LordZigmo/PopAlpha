#!/usr/bin/env python3
"""
Upload a freshly-baked .papb to Supabase Storage at the canonical path
the iOS app reads on launch:

    card-images/catalog-bundles/v1/siglip2_catalog_v1.papb

Usage:
    python upload_catalog_bundle.py --input siglip2_catalog_v1.papb

Notes:
    - Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local via
      the same load_env_local() helper as build_catalog_bundle.py.
    - upsert=True so re-uploading overwrites the existing object. The
      iOS app fetches by fixed path, so version bumps live in the path
      itself (v1, v2, ...) and not in the filename suffix.
    - Sets a short cache-control so premium devices pick up new bakes
      on next cold launch instead of holding a stale CDN copy.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from build_catalog_bundle import load_env_local
from supabase import create_client

BUCKET = "card-images"
OBJECT_PATH = "catalog-bundles/v1/siglip2_catalog_v1.papb"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True,
                        help="path to the .papb file to upload")
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"input file not found: {args.input}")

    load_env_local()
    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    data = args.input.read_bytes()
    print(f"[upload] {args.input} ({len(data) / 1_000_000:.1f} MB) "
          f"-> {BUCKET}/{OBJECT_PATH}")

    storage = sb.storage.from_(BUCKET)
    # supabase-py's upload() rejects existing objects unless upsert is set.
    # We pass upsert via file_options because the python SDK plumbs it
    # through to the underlying multipart request.
    res = storage.upload(
        path=OBJECT_PATH,
        file=data,
        file_options={
            "content-type": "application/octet-stream",
            "cache-control": "public, max-age=300",
            "upsert": "true",
        },
    )
    # supabase-py returns an UploadResponse; print its full_path to confirm.
    print(f"[upload] OK -> {getattr(res, 'full_path', res)}")


if __name__ == "__main__":
    main()

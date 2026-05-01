#!/usr/bin/env python3
"""
Build the PopAlpha catalog bundle (.papb) — a single binary file
containing the SigLIP-2 catalog embeddings + metadata for the
offline scanner.

Format goals:
    - Single file (one ODR asset, one mmap target on iOS).
    - mmap-friendly: header at the start, fixed-size embeddings
      matrix in the middle, variable-length metadata at the end.
      iOS code can mmap the embeddings region and let the OS page
      it in lazily — keeps RAM pressure low.
    - Forward-compatible: explicit format_version + per-row
      reserved bytes for future fields without breaking older
      readers.
    - Self-describing: header carries num_rows + dim, no magic
      constants in the iOS code.

Wire format (all multi-byte integers little-endian):

    Offset  Size  Field              Notes
    ─────── ───── ──────────────────  ───────────────────────────────
    0       4     magic              0x50415042 (b"PAPB" — PopAlpha Bundle)
    4       4     format_version     2
    8       4     num_rows           e.g. 23105
    12      4     vector_dim         768
    16      1     dtype              0=float32, 1=float16 (IEEE 754)
    17      15    reserved_a         zeros
    32      8     model_version_off  offset of model_version string
    40      8     metadata_off       offset of metadata table
    48      8     string_blob_off    offset of string blob
    56      8     string_blob_size   bytes in string blob

    64      ...   embeddings         num_rows × vector_dim × dtype
                                     L2-normalized (cosine == dot)
                                     dtype=0: 4 bytes per element
                                     dtype=1: 2 bytes per element

    metadata_off:
                  num_rows × {
                    uint32 slug_off              offset into string blob
                    uint32 set_name_off
                    uint32 card_number_off
                    uint32 language_off          // "EN" | "JP"
                    uint32 variant_index
                    uint8  source                // 0=catalog, 1=user_correction
                    uint8  reserved[3]
                  } = 24 bytes per row

    string_blob_off:
                  All distinct strings concatenated, each null-terminated
                  UTF-8. The first byte at string_blob_off is always \\0
                  so an offset of 0 means "empty / NULL".

    model_version_off:
                  A single null-terminated UTF-8 string describing the
                  model that produced these embeddings, e.g.
                  "siglip2-base-patch16-384-v1". Used by the iOS app
                  to verify the bundle matches the bundled CoreML
                  model before running queries.

Size estimate for 23,105 rows:
    Embeddings: 23105 × 768 × 4 = ~71 MB
    Metadata:   23105 × 24      = ~555 KB
    Strings:    ~3-5 MB (avg 30-50 chars × 4 fields per row)
    Total:      ~75 MB uncompressed

Usage:
    cd cog/siglip-features
    source venv/bin/activate
    python build_catalog_bundle.py \\
      --output siglip2_catalog_v1.papb       # full catalog
    python build_catalog_bundle.py \\
      --output test.papb --limit 100         # smoke test

Idempotent — re-running overwrites the output file.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np
from supabase import create_client


MAGIC = 0x50415042  # b"PAPB" little-endian
FORMAT_VERSION = 2  # v2 added the dtype byte for FP16 support
HEADER_SIZE = 64  # bytes; matches the layout above

DTYPE_FLOAT32 = 0
DTYPE_FLOAT16 = 1

SIGLIP_MODEL_VERSION = "siglip2-base-patch16-384-v1"
EMBEDDING_DIM = 768

# Per-row metadata struct: slug_off, set_off, num_off, lang_off,
# variant_index (all uint32 LE), source (uint8), reserved[3].
METADATA_STRUCT = struct.Struct("<IIIIIBxxx")
assert METADATA_STRUCT.size == 24


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


class StringBlob:
    """Append-only string interner. Returns offsets into a single
    null-separated UTF-8 blob. Offset 0 is reserved for the leading
    NUL so callers can treat 0 as 'no string'."""

    def __init__(self) -> None:
        self._buf = bytearray(b"\x00")  # offset 0 is the leading NUL
        self._cache: dict[str, int] = {"": 0}

    def add(self, s: str | None) -> int:
        if not s:
            return 0
        if s in self._cache:
            return self._cache[s]
        offset = len(self._buf)
        self._buf.extend(s.encode("utf-8"))
        self._buf.append(0)  # null terminator
        self._cache[s] = offset
        return offset

    def bytes(self) -> bytes:
        return bytes(self._buf)


def fetch_catalog(sb, limit: int | None) -> list[dict]:
    """Pull every active SigLIP catalog row + user_correction anchor.
    Both populations participate in on-device retrieval."""
    PAGE = 1000
    out: list[dict] = []
    cursor = 0
    while True:
        resp = (
            sb.table("card_image_embeddings")
            .select(
                "canonical_slug, set_name, card_number, language, "
                "variant_index, source, embedding"
            )
            .eq("model_version", SIGLIP_MODEL_VERSION)
            .eq("crop_type", "full")
            .order("canonical_slug")
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


def parse_pgvector(s: str) -> np.ndarray:
    """pgvector text representation: '[0.1,0.2,...]' → np.float32 array."""
    return np.fromstring(s.strip("[]"), dtype=np.float32, sep=",")


def write_bundle(rows: list[dict], output: Path, *, quantize_fp16: bool) -> None:
    n = len(rows)
    if n == 0:
        raise ValueError("no rows to write — check filters / catalog state")

    print(f"[bundle] {n} rows, building string blob + metadata table ...")
    blob = StringBlob()
    metadata_buf = bytearray(METADATA_STRUCT.size * n)

    # Pre-pack metadata into the output buffer
    SOURCE_CATALOG = 0
    SOURCE_USER_CORRECTION = 1
    for i, row in enumerate(rows):
        slug_off = blob.add(row["canonical_slug"])
        set_off = blob.add(row.get("set_name"))
        num_off = blob.add(row.get("card_number"))
        lang_off = blob.add(row.get("language"))
        variant = int(row.get("variant_index") or 0)
        src = SOURCE_USER_CORRECTION if row.get("source") == "user_correction" else SOURCE_CATALOG
        METADATA_STRUCT.pack_into(
            metadata_buf, i * METADATA_STRUCT.size,
            slug_off, set_off, num_off, lang_off, variant, src,
        )

    print(f"[bundle] string blob: {len(blob.bytes())} bytes, "
          f"metadata: {len(metadata_buf)} bytes")

    print(f"[bundle] parsing + L2-normalizing embeddings (fp32) ...")
    embeddings_fp32 = np.zeros((n, EMBEDDING_DIM), dtype=np.float32)
    for i, row in enumerate(rows):
        emb = row["embedding"]
        vec = parse_pgvector(emb) if isinstance(emb, str) else np.asarray(emb, dtype=np.float32)
        if vec.shape[0] != EMBEDDING_DIM:
            raise ValueError(
                f"row {i} ({row['canonical_slug']}) has dim {vec.shape[0]} != {EMBEDDING_DIM}"
            )
        # Re-normalize defensively. Catalog should already be L2-normed
        # but float drift across (Python writer, Postgres roundtrip,
        # CoreML writer) is real and cheap to fix once.
        norm = np.linalg.norm(vec)
        embeddings_fp32[i] = vec / norm if norm > 0 else vec

    if quantize_fp16:
        # IEEE 754 fp16 — same bit layout iOS will load via vDSP_vfromlh.
        # CoreML feasibility test showed FP16 query × FP32 catalog still
        # gets 90% top-1 vs HF (matched FP32). FP16 catalog × FP16 query
        # is even more aligned because both sides have the same precision.
        embeddings = embeddings_fp32.astype(np.float16)
        # Re-normalize after quantization since fp16 rounding may have
        # nudged the L2 norms slightly off 1.0.
        norms = np.linalg.norm(embeddings.astype(np.float32), axis=1, keepdims=True)
        norms[norms == 0] = 1
        embeddings = (embeddings_fp32 / norms).astype(np.float16)
        dtype_byte = DTYPE_FLOAT16
        print(f"[bundle] quantized to fp16 ({embeddings.nbytes / (1024*1024):.1f} MB)")
    else:
        embeddings = embeddings_fp32
        dtype_byte = DTYPE_FLOAT32
        print(f"[bundle] kept fp32 ({embeddings.nbytes / (1024*1024):.1f} MB)")

    # Layout the file.
    embeddings_off = HEADER_SIZE
    embeddings_size = embeddings.nbytes
    metadata_off = embeddings_off + embeddings_size
    string_blob_off = metadata_off + len(metadata_buf)

    # model_version string at the very end so the offsets above are
    # known before we serialize the version bytes.
    version_bytes = SIGLIP_MODEL_VERSION.encode("utf-8") + b"\x00"
    model_version_off = string_blob_off + len(blob.bytes())

    # Header layout (v2): 4+4+4+4 (magic/version/n/dim) + 1 (dtype) +
    #   15 (reserved_a) + 8+8+8+8 (model_version_off, metadata_off,
    #   string_blob_off, string_blob_size) = 64 bytes.
    header = struct.pack(
        "<IIIIB15sQQQQ",
        MAGIC,
        FORMAT_VERSION,
        n,
        EMBEDDING_DIM,
        dtype_byte,
        b"\x00" * 15,
        model_version_off,
        metadata_off,
        string_blob_off,
        len(blob.bytes()),
    )
    assert len(header) == HEADER_SIZE, f"header size {len(header)} != {HEADER_SIZE}"

    print(f"[bundle] writing {output} ...")
    t0 = time.monotonic()
    with open(output, "wb") as f:
        f.write(header)
        f.write(embeddings.tobytes())  # row-major, float32 LE
        f.write(metadata_buf)
        f.write(blob.bytes())
        f.write(version_bytes)

    file_size = output.stat().st_size
    print(f"[bundle] wrote {file_size / (1024*1024):.1f} MB in {time.monotonic()-t0:.1f}s")
    print(f"[bundle] layout:")
    print(f"  header:        0..{HEADER_SIZE} ({HEADER_SIZE} bytes)")
    print(f"  embeddings:    {embeddings_off}..{metadata_off} ({embeddings_size:,} bytes)")
    print(f"  metadata:      {metadata_off}..{string_blob_off} ({len(metadata_buf):,} bytes)")
    print(f"  string blob:   {string_blob_off}..{model_version_off} ({len(blob.bytes()):,} bytes)")
    print(f"  model_version: {model_version_off}..{file_size} ({len(version_bytes)} bytes)")


def verify_round_trip(output: Path, expected_rows: list[dict]) -> None:
    """Read back the file we just wrote and verify a few rows match."""
    print(f"\n[verify] round-tripping {output} ...")
    with open(output, "rb") as f:
        data = f.read()

    (magic, version, num_rows, dim, dtype_byte, _reserved_a,
     mv_off, meta_off, blob_off, blob_size) = struct.unpack(
        "<IIIIB15sQQQQ", data[:HEADER_SIZE],
    )
    assert magic == MAGIC, f"magic mismatch: {magic:#x} vs {MAGIC:#x}"
    assert version == FORMAT_VERSION, f"version mismatch: {version} vs {FORMAT_VERSION}"
    assert num_rows == len(expected_rows), f"num_rows {num_rows} vs {len(expected_rows)}"
    assert dim == EMBEDDING_DIM, f"dim {dim} vs {EMBEDDING_DIM}"
    assert dtype_byte in (DTYPE_FLOAT32, DTYPE_FLOAT16), f"unknown dtype byte {dtype_byte}"

    np_dtype = np.float32 if dtype_byte == DTYPE_FLOAT32 else np.float16
    bytes_per_element = 4 if dtype_byte == DTYPE_FLOAT32 else 2
    embeddings = np.frombuffer(
        data[HEADER_SIZE : HEADER_SIZE + num_rows * dim * bytes_per_element],
        dtype=np_dtype,
    ).reshape(num_rows, dim)
    print(f"  dtype: {'float32' if dtype_byte == DTYPE_FLOAT32 else 'float16'}")

    # Spot-check 3 random rows
    import random
    sample = random.sample(range(num_rows), min(3, num_rows))
    for idx in sample:
        offsets = METADATA_STRUCT.unpack_from(data, meta_off + idx * METADATA_STRUCT.size)
        slug_off, set_off, num_off, lang_off, variant, src = offsets
        # Read null-terminated strings from blob
        def read_str(off):
            if off == 0:
                return None
            end = data.index(b"\x00", blob_off + off)
            return data[blob_off + off:end].decode("utf-8")
        slug = read_str(slug_off)
        set_name = read_str(set_off)
        card_num = read_str(num_off)
        language = read_str(lang_off)
        expected = expected_rows[idx]
        assert slug == expected["canonical_slug"], f"slug mismatch row {idx}: {slug} vs {expected['canonical_slug']}"
        assert set_name == expected.get("set_name"), f"set mismatch row {idx}"
        assert card_num == expected.get("card_number"), f"card_number mismatch row {idx}"
        assert language == expected.get("language"), f"language mismatch row {idx}"
        # Embedding should be ~unit-norm. fp16 has more drift than fp32
        # (16-bit floats round; ~1024 quantization buckets in [0, 1])
        # so widen the tolerance for fp16.
        actual_norm = float(np.linalg.norm(embeddings[idx].astype(np.float32)))
        norm_tol = 5e-3 if dtype_byte == DTYPE_FLOAT16 else 1e-4
        assert abs(actual_norm - 1.0) < norm_tol, f"norm drift row {idx}: |{actual_norm} - 1.0| > {norm_tol}"
        print(f"  row {idx}: ✓ {slug} ({set_name} #{card_num}, {language}, src={src})  norm={actual_norm:.6f}")

    # Read model_version string
    version_str = data[mv_off:].split(b"\x00", 1)[0].decode("utf-8")
    print(f"  model_version: {version_str}")
    assert version_str == SIGLIP_MODEL_VERSION

    print(f"[verify] all checks passed ✓")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True,
                        help="output .papb file path")
    parser.add_argument("--limit", type=int, default=None,
                        help="cap rows for smoke testing")
    parser.add_argument("--quantize-fp16", action="store_true",
                        help=("Store embeddings as IEEE 754 float16 instead of "
                              "float32. Halves the bundle size; CoreML "
                              "feasibility test confirmed FP16 matches FP32 "
                              "top-1 accuracy on retrieval. Recommended for "
                              "iOS bundle distribution."))
    args = parser.parse_args()

    load_env_local()
    sb = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    print(f"[fetch] pulling SigLIP catalog rows from Supabase ...")
    t0 = time.monotonic()
    rows = fetch_catalog(sb, args.limit)
    print(f"[fetch] {len(rows)} rows in {time.monotonic()-t0:.1f}s")

    write_bundle(rows, args.output, quantize_fp16=args.quantize_fp16)
    verify_round_trip(args.output, rows)


if __name__ == "__main__":
    main()

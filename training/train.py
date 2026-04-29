#!/usr/bin/env python3
"""
Stage D fine-tune: trainable projection head on top of frozen CLIP ViT-L/14.

Architecture:

    image (anchor / positive / hard_neg)
       ↓ frozen CLIP image encoder (ViT-L/14)
    768-dim raw embedding
       ↓ trainable residual MLP head (768 → 512 → 768, zero-init last layer)
    768-dim fine-tuned embedding
       ↓ L2 normalize
    out

The residual + zero-init means the *day-zero* model is bit-for-bit identical
to off-the-shelf CLIP. Only what the gradient actually wants to change moves.
This is the safest possible starting point for small datasets — we can never
do worse than baseline on epoch 0.

Loss:
    InfoNCE / NT-Xent. Per anchor we have:
      - 1 positive (the labeled catalog image)
      - K hard negatives (eval_confusion_pair + variant_sibling slugs)
      - B-1 in-batch negatives (other anchors' positives)

Inputs:
    --dataset DIR — path to a dataset directory produced by
                    `npm run dataset:export`. Must contain manifest.json,
                    train.jsonl, val.jsonl, and images/.

Outputs (under DIR/run-<unix_ts>/ unless --out specified):
    projection.pt          PyTorch state_dict for ProjectionHead
    projection.json        Same weights as JSON for JS-side deployment
    training-stats.json    Per-epoch loss, val top-1/top-5, best checkpoint marker

Usage:
    python training/train.py --dataset ./data/finetune-2026-04-29
    python training/train.py --dataset ./data/finetune-2026-04-29 --epochs 50

Note on the val metric:
    The val top-1 reported here is *within-batch retrieval accuracy* — for
    each val anchor, can it pick its positive out of the val batch's 92
    positives? That's a tractable signal during training but it is NOT the
    same as the production eval which retrieves against ~19k catalog cards.
    The real metric is `npm run eval:run` after the projection ships into
    the inference path.
"""
import argparse
import json
import os
import sys
import time
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torch.utils.data import Dataset, DataLoader
from transformers import CLIPProcessor, CLIPModel


# ── Configuration ───────────────────────────────────────────────────────────

# Match what andreasjansson/clip-features (our production embedder) uses so
# the projection head trained on these embeddings transfers to inference.
# Both use OpenAI's original CLIP ViT-L/14 weights.
MODEL_NAME = "openai/clip-vit-large-patch14"
EMBED_DIM = 768

DEVICE = (
    "cuda" if torch.cuda.is_available()
    else "mps" if torch.backends.mps.is_available()
    else "cpu"
)


# ── Model ───────────────────────────────────────────────────────────────────

class ProjectionHead(nn.Module):
    """
    Residual 2-layer MLP. Last layer is zero-initialized so the day-zero
    model is identity (output == normalized input). Training only deviates
    from that identity where gradients say it pays.

    Tiny: ~660K params for hidden=512, dim=768. Easy to ship as JSON.
    """
    def __init__(self, dim=EMBED_DIM, hidden=512):
        super().__init__()
        self.fc1 = nn.Linear(dim, hidden)
        self.act = nn.GELU()
        self.fc2 = nn.Linear(hidden, dim)
        nn.init.zeros_(self.fc2.weight)
        nn.init.zeros_(self.fc2.bias)

    def forward(self, x):
        return F.normalize(x + self.fc2(self.act(self.fc1(x))), dim=-1)


# ── Image loading + embedding ───────────────────────────────────────────────

def load_image(path_or_url, processor):
    """Fetch + preprocess one image. Returns the [3, H, W] tensor CLIP wants."""
    if str(path_or_url).startswith("http"):
        r = requests.get(path_or_url, timeout=30)
        r.raise_for_status()
        img = Image.open(BytesIO(r.content)).convert("RGB")
    else:
        img = Image.open(path_or_url).convert("RGB")
    inputs = processor(images=img, return_tensors="pt")
    return inputs["pixel_values"].squeeze(0)


def precompute_embeddings(rows, dataset_dir, model, processor):
    """
    Embed every unique image (anchor JPEG + positive URL + hard-negative URLs)
    through frozen CLIP. Returns a dict from (kind, key) -> 768-dim tensor.
    Failures are logged + collected; rows depending on a failed key get
    filtered out at TripletDataset construction.

    Pre-computing once is much cheaper than re-embedding per epoch — frozen
    CLIP is the expensive part and its outputs never change.
    """
    keys = set()
    for row in rows:
        keys.add(("local", row["anchor_local_path"]))
        keys.add(("url", row["positive"]["mirrored_primary_image_url"]))
        for n in row["hard_negatives"]:
            keys.add(("url", n["mirrored_primary_image_url"]))

    print(f"[train] embedding {len(keys)} unique images on {DEVICE}...")
    embeddings = {}
    failed = []
    model.eval()
    with torch.no_grad():
        for i, (kind, key) in enumerate(keys):
            try:
                if kind == "local":
                    pixel_values = load_image(dataset_dir / key, processor)
                else:
                    pixel_values = load_image(key, processor)
                pixel_values = pixel_values.unsqueeze(0).to(DEVICE)
                emb = model.get_image_features(pixel_values)
                emb = F.normalize(emb, dim=-1)
                embeddings[(kind, key)] = emb.squeeze(0).cpu()
            except Exception as e:
                failed.append((kind, key, str(e)))
            if (i + 1) % 50 == 0:
                print(f"  {i+1}/{len(keys)} done · {len(failed)} failed")
    return embeddings, failed


# ── Dataset / collation ─────────────────────────────────────────────────────

class TripletDataset(Dataset):
    """
    One usable item per row. Rows whose anchor or positive failed to embed
    are dropped at construction; failed hard negatives are silently filtered
    from each row's neg list (anchor + positive are required, hard negs are
    optional — InfoNCE falls back to in-batch negatives).
    """
    def __init__(self, rows, embeddings):
        self.usable = []
        for row in rows:
            anchor_key = ("local", row["anchor_local_path"])
            pos_key = ("url", row["positive"]["mirrored_primary_image_url"])
            if anchor_key not in embeddings or pos_key not in embeddings:
                continue
            neg_embs = []
            for n in row["hard_negatives"]:
                k = ("url", n["mirrored_primary_image_url"])
                if k in embeddings:
                    neg_embs.append(embeddings[k])
            self.usable.append({
                "anchor_emb": embeddings[anchor_key],
                "positive_emb": embeddings[pos_key],
                "hard_neg_embs": neg_embs,
                "positive_slug": row["positive"]["slug"],
                "anchor_id": row["anchor_id"],
            })
        print(f"[train] usable rows after filter: {len(self.usable)}")

    def __len__(self):
        return len(self.usable)

    def __getitem__(self, idx):
        return self.usable[idx]


def collate_fn(batch):
    """
    Stack anchors and positives. Pad hard negatives to the batch's max K and
    return a mask so InfoNCE can ignore padding.
    """
    anchors = torch.stack([b["anchor_emb"] for b in batch])
    positives = torch.stack([b["positive_emb"] for b in batch])
    max_k = max((len(b["hard_neg_embs"]) for b in batch), default=0)
    if max_k == 0:
        hard_negs = torch.zeros(len(batch), 0, EMBED_DIM)
        hard_neg_mask = torch.zeros(len(batch), 0, dtype=torch.bool)
    else:
        hard_negs = torch.zeros(len(batch), max_k, EMBED_DIM)
        hard_neg_mask = torch.zeros(len(batch), max_k, dtype=torch.bool)
        for i, b in enumerate(batch):
            for j, neg in enumerate(b["hard_neg_embs"]):
                hard_negs[i, j] = neg
                hard_neg_mask[i, j] = True
    return anchors, positives, hard_negs, hard_neg_mask


# ── Loss + eval ─────────────────────────────────────────────────────────────

def info_nce_loss(anchor, positive, hard_negs, hard_neg_mask, temperature=0.07):
    """
    Cross-entropy with positive at index i (in-batch positive) and competing
    candidates being the rest of the in-batch positives plus the row's own
    hard negatives.

    Inputs are already L2-normalized (projection head ends with F.normalize).
    """
    B = anchor.shape[0]

    inbatch_sim = anchor @ positive.T  # [B, B] — diagonal = positive

    if hard_negs.shape[1] > 0:
        # anchor[i] · hard_negs[i, k]
        hard_sim = (anchor.unsqueeze(1) * hard_negs).sum(dim=-1)  # [B, K]
        # Padding gets pushed below any real similarity. -1e4 is safe in fp32.
        hard_sim = hard_sim.masked_fill(~hard_neg_mask, -1e4)
    else:
        hard_sim = torch.zeros(B, 0, device=anchor.device)

    logits = torch.cat([inbatch_sim, hard_sim], dim=-1) / temperature
    targets = torch.arange(B, device=anchor.device)
    return F.cross_entropy(logits, targets)


def within_batch_topk(anchor_embs, positive_embs, k=5):
    """
    Within-batch retrieval accuracy: for each anchor, did its positive land
    in the top K of similarity against all in-batch positives? Diagnostic
    only — production eval uses /api/scan/identify against the full catalog.
    """
    sims = anchor_embs @ positive_embs.T  # [B, B]
    eff_k = min(k, sims.shape[1])
    topk = sims.topk(eff_k, dim=-1).indices  # [B, eff_k]
    targets = torch.arange(sims.shape[0], device=sims.device).unsqueeze(-1)
    return (topk == targets).any(dim=-1).float().mean().item()


def full_pool_topk(val_anchor_embs, val_anchor_target_idx, all_positive_embs, k=5):
    """
    Retrieval accuracy against the full candidate pool of train+val unique
    positives. For each val anchor, find its true positive in a ranking of
    every distinct slug's positive — the candidate pool includes all the
    train slugs the model HAS seen as well as the val slugs it hasn't.

    This is the metric that surfaces lighthouse failures: if the model has
    learned to map "anything holographic-foil" to a specific train slug's
    embedding region, val anchors with similar visual properties land on
    that train slug instead of their (unseen) val slug.

    val_anchor_embs:        [V, D]  — projected val anchors
    val_anchor_target_idx:  [V]     — index into all_positive_embs of each
                                       val anchor's true positive
    all_positive_embs:      [P, D]  — projected unique positives, train+val
    """
    sims = val_anchor_embs @ all_positive_embs.T  # [V, P]
    eff_k = min(k, sims.shape[1])
    topk = sims.topk(eff_k, dim=-1).indices       # [V, eff_k]
    targets = val_anchor_target_idx.unsqueeze(-1)  # [V, 1]
    return (topk == targets).any(dim=-1).float().mean().item()


# ── Main loop ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True,
                        help="Path to data/finetune-YYYY-MM-DD/")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--temperature", type=float, default=0.07)
    parser.add_argument("--hidden", type=int, default=512)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=None,
                        help="Output dir; defaults to <dataset>/run-<unix_ts>")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    dataset_dir = Path(args.dataset).resolve()
    out_dir = Path(args.out) if args.out else dataset_dir / f"run-{int(time.time())}"
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((dataset_dir / "manifest.json").read_text())
    train_rows = [json.loads(l) for l in (dataset_dir / "train.jsonl").read_text().splitlines() if l.strip()]
    val_rows = [json.loads(l) for l in (dataset_dir / "val.jsonl").read_text().splitlines() if l.strip()]

    print(f"[train] dataset version: {manifest['dataset_version']}")
    print(f"[train] train={len(train_rows)} · val={len(val_rows)}")
    print(f"[train] device: {DEVICE}")
    print(f"[train] backbone: {MODEL_NAME}")

    print(f"[train] loading CLIP weights...")
    model = CLIPModel.from_pretrained(MODEL_NAME).to(DEVICE)
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)

    embeddings, failed = precompute_embeddings(train_rows + val_rows, dataset_dir, model, processor)
    if failed:
        print(f"[train] WARNING: {len(failed)} images failed to embed")
        for kind, key, err in failed[:5]:
            print(f"  - {kind} {key}: {err[:120]}")
        if len(failed) > 5:
            print(f"  ... +{len(failed)-5} more")

    train_ds = TripletDataset(train_rows, embeddings)
    val_ds = TripletDataset(val_rows, embeddings)
    if len(train_ds) == 0 or len(val_ds) == 0:
        print("[train] FATAL: train or val set is empty after filtering. Aborting.")
        sys.exit(1)

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,
                              collate_fn=collate_fn, drop_last=False)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                            collate_fn=collate_fn)

    proj = ProjectionHead(dim=EMBED_DIM, hidden=args.hidden).to(DEVICE)
    optimizer = torch.optim.AdamW(proj.parameters(), lr=args.lr, weight_decay=1e-4)

    # ── Val candidate pool: every distinct slug across train+val ──────
    # The val metric we compute below retrieves each val anchor against
    # this full pool. Two reasons:
    #   1. Slug-disjoint split means val slugs were never trained on.
    #      If we restricted retrieval to val-only positives, we'd be
    #      asking "out of these N unfamiliar cards, find yours" — too
    #      easy and uninformative about whether the model can resist
    #      lighthouse pull from train slugs.
    #   2. Lighthouses live in train. The right test of whether the
    #      projection has fixed the lighthouse problem is "given a
    #      val anchor, can it beat all the train slugs that off-the-
    #      shelf CLIP would mistakenly attract it to?" The full pool
    #      lets us measure exactly that.
    all_rows = train_ds.usable + val_ds.usable
    pool_emb_by_slug = {}
    for row in all_rows:
        if row["positive_slug"] not in pool_emb_by_slug:
            pool_emb_by_slug[row["positive_slug"]] = row["positive_emb"]
    pool_slug_list = list(pool_emb_by_slug.keys())
    pool_slug_to_idx = {s: i for i, s in enumerate(pool_slug_list)}
    pool_positives_all = torch.stack([pool_emb_by_slug[s] for s in pool_slug_list]).to(DEVICE)
    print(f"[train] retrieval pool: {len(pool_slug_list)} unique slugs (train + val)")

    val_anchors_all = torch.stack([r["anchor_emb"] for r in val_ds.usable]).to(DEVICE)
    val_target_idx = torch.tensor(
        [pool_slug_to_idx[r["positive_slug"]] for r in val_ds.usable],
        dtype=torch.long,
    ).to(DEVICE)

    # Baseline: identity projection (zero-init residual = bit-identical to raw CLIP).
    # On the slug-disjoint val set against the full train+val pool, this
    # answers "what does off-the-shelf CLIP get on cards it has never seen,
    # competing against the lighthouse pull from cards it has?"
    with torch.no_grad():
        baseline_top1 = full_pool_topk(val_anchors_all, val_target_idx, pool_positives_all, k=1)
        baseline_top5 = full_pool_topk(val_anchors_all, val_target_idx, pool_positives_all, k=5)
    print(f"[train] BASELINE (off-the-shelf CLIP, val-vs-full-pool): "
          f"top1={baseline_top1:.3f} · top5={baseline_top5:.3f}")

    history = []
    best_val_top1 = baseline_top1
    best_epoch = 0
    print(f"[train] training {args.epochs} epochs...")
    for epoch in range(args.epochs):
        proj.train()
        epoch_loss = 0.0
        n_batches = 0
        for anchors, positives, hard_negs, hard_neg_mask in train_loader:
            anchors = anchors.to(DEVICE)
            positives = positives.to(DEVICE)
            hard_negs = hard_negs.to(DEVICE)
            hard_neg_mask = hard_neg_mask.to(DEVICE)

            anchors_p = proj(anchors)
            positives_p = proj(positives)
            if hard_negs.shape[1] > 0:
                B, K, D = hard_negs.shape
                hard_negs_p = proj(hard_negs.view(B * K, D)).view(B, K, D)
            else:
                hard_negs_p = hard_negs

            loss = info_nce_loss(anchors_p, positives_p, hard_negs_p,
                                 hard_neg_mask, args.temperature)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += loss.item()
            n_batches += 1

        avg_loss = epoch_loss / max(1, n_batches)

        proj.eval()
        with torch.no_grad():
            val_anchors_p = proj(val_anchors_all)
            pool_positives_p = proj(pool_positives_all)
            val_top1 = full_pool_topk(val_anchors_p, val_target_idx, pool_positives_p, k=1)
            val_top5 = full_pool_topk(val_anchors_p, val_target_idx, pool_positives_p, k=5)

        history.append({
            "epoch": epoch + 1,
            "loss": avg_loss,
            "val_top1": val_top1,
            "val_top5": val_top5,
        })
        marker = ""
        if val_top1 > best_val_top1:
            best_val_top1 = val_top1
            best_epoch = epoch + 1
            torch.save(proj.state_dict(), out_dir / "projection.pt")
            marker = " ← best"
        print(f"[train] epoch {epoch+1:3d} · loss={avg_loss:.4f} · "
              f"val_top1={val_top1:.3f} · val_top5={val_top5:.3f}{marker}")

    # If the best epoch was epoch 0 (i.e. baseline beats every fine-tuned
    # checkpoint), there's no projection.pt to save — write the identity-init
    # state so deployment never reads an empty file.
    if not (out_dir / "projection.pt").exists():
        print("[train] no fine-tuned checkpoint beat baseline; saving identity-init weights")
        torch.save(proj.state_dict(), out_dir / "projection.pt")

    # Reload best checkpoint for the final export
    proj.load_state_dict(torch.load(out_dir / "projection.pt", map_location=DEVICE))
    proj.eval()

    # JSON export for JS-side inference (small enough that JSON is fine —
    # 768x512 + 512 + 512x768 + 768 ≈ 660K floats ≈ 5MB JSON)
    proj_json = {
        "fc1_weight": proj.fc1.weight.detach().cpu().numpy().tolist(),
        "fc1_bias": proj.fc1.bias.detach().cpu().numpy().tolist(),
        "fc2_weight": proj.fc2.weight.detach().cpu().numpy().tolist(),
        "fc2_bias": proj.fc2.bias.detach().cpu().numpy().tolist(),
        "embed_dim": EMBED_DIM,
        "hidden_dim": args.hidden,
        "activation": "gelu",
        "residual": True,
        "normalize_output": True,
    }
    (out_dir / "projection.json").write_text(json.dumps(proj_json))

    stats = {
        "dataset_version": manifest["dataset_version"],
        "dataset_dir": str(dataset_dir),
        "model_backbone": MODEL_NAME,
        "embed_dim": EMBED_DIM,
        "args": vars(args),
        "device": DEVICE,
        "baseline_val_top1": baseline_top1,
        "baseline_val_top5": baseline_top5,
        "best_val_top1": best_val_top1,
        "best_epoch": best_epoch,
        "delta_top1_vs_baseline": best_val_top1 - baseline_top1,
        "n_train": len(train_ds),
        "n_val": len(val_ds),
        "n_failed_embeddings": len(failed),
        "history": history,
    }
    (out_dir / "training-stats.json").write_text(json.dumps(stats, indent=2))

    print()
    print(f"[train] BASELINE   top1={baseline_top1:.3f} · top5={baseline_top5:.3f}")
    print(f"[train] FINE-TUNED top1={best_val_top1:.3f} (epoch {best_epoch}) · top5={history[best_epoch-1]['val_top5']:.3f}" if best_epoch > 0
          else f"[train] FINE-TUNED no checkpoint beat baseline")
    print(f"[train] DELTA      top1 {best_val_top1 - baseline_top1:+.3f}")
    print(f"[train] artifacts in: {out_dir}")


if __name__ == "__main__":
    main()

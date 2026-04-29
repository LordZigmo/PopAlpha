# Stage D fine-tune — projection head over CLIP ViT-L/14

## What this is

A small trainable MLP (`ProjectionHead` in `train.py`) sits on top of the
frozen CLIP ViT-L/14 image encoder and learns to push apart the
visual-confusion pairs we keep losing in production.

Architecture:

```
image → frozen CLIP image encoder (ViT-L/14, OpenAI weights)
      → 768-dim raw embedding
      → trainable residual MLP (768 → hidden → 768, zero-init last layer)
      → L2-normalized 768-dim fine-tuned embedding
```

Day-zero behavior: zero-init residual means the model is *bit-identical* to
off-the-shelf CLIP at the start of training. The loss can only improve
things — there's no risk of the projection making the baseline worse on
epoch 0.

## What it consumes

A dataset directory produced by `npm run dataset:export`:

```
data/finetune-YYYY-MM-DD/
├── manifest.json       — dataset version + flags + stats
├── train.jsonl         — ~80% of rows
├── val.jsonl           — ~20% (stratified by canonical_slug)
└── images/<sha256>.jpg — anchor JPEGs
```

See `docs/scanner-finetune-runbook.md` for the row schema.

## What it produces

Under `<dataset>/run-<unix_ts>/`:

```
projection.pt           — PyTorch state_dict (best val checkpoint)
projection.json         — same weights as JSON for JS-side inference
training-stats.json     — baseline vs fine-tuned val top-1/top-5,
                          per-epoch loss curve, hyperparameters
```

## Running it locally

Setup:

```bash
cd training
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Train:

```bash
python train.py --dataset ../data/finetune-2026-04-29
```

On Apple Silicon, MPS is auto-detected. On CUDA boxes, GPU is used. Training
277 anchors × 30 epochs on a frozen ViT-L/14 takes ~5-10 min on MPS, ~2 min
on a T4, and the bulk of that is the one-time embed-everything pass.

Useful flags:

```bash
--epochs 50
--batch-size 32
--lr 1e-3
--temperature 0.07     # NT-Xent temperature
--hidden 512           # projection MLP hidden dim
--out ./manual-out     # override default run-<ts> dir
```

## Reading the output

The script always reports:

```
[train] BASELINE   top1=0.XYZ · top5=0.XYZ
[train] FINE-TUNED top1=0.XYZ (epoch N) · top5=0.XYZ
[train] DELTA      top1 +0.XYZ
```

What "top1" means here: **within-batch retrieval accuracy** on the val
set — for each val anchor, can it pick its positive out of the 92 other
val positives in similarity space?

This is a *training-time diagnostic*, not the production metric. It's
tractable to compute from the precomputed embeddings, and it correlates
with the real metric, but the real metric is `npm run eval:run` against
the full `card_image_embeddings` index after the projection ships into
the inference path.

If `DELTA` is significantly positive, the projection is learning useful
structure. If it's flat or negative, that's an honest signal that:

  - 277 anchors is too few for contrastive fine-tuning to bite
  - the hard-negative mining isn't surfacing enough confusion pairs
  - the projection-head architecture is wrong (e.g., too small/large)

Either way, the smoke run answers the question.

## Deployment (after a successful smoke run)

Sketch — not yet implemented. Once `DELTA` is meaningfully positive:

1. **Re-project the catalog**: read every row from
   `card_image_embeddings`, apply `projection.json` in JS, write to a
   new `model_version` tag (e.g. `popalpha-clip-vitl14-proj-v1`).
2. **Apply at query time**: in `app/api/scan/identify/route.ts`, run the
   raw CLIP embedding through the same projection before pgvector kNN.
   The projection is small enough (~660K params, ~5MB JSON) to ship
   inline with the route bundle.
3. **Bump filter**: change the kNN `model_version` filter to the new tag.
4. **Re-run `npm run eval:run`**: the persisted run row will diff against
   the previous baseline so we see exactly how much the projection
   moved top-1 on the production retrieval path.

Steps 1-3 are mechanical; we'll do them after we know the projection is
worth shipping.

## Modal-based runs (optional)

For consistent GPU access (cheaper than upgrading the laptop), wrap
`train.py` in a Modal app. Not yet shipped — see the runbook's "Training
infra options" section. Local CPU/MPS is fine for v1.

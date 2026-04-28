# Scanner fine-tune runbook (Stage D)

Companion to `docs/scanner-augmentation-playbook.md`. The augmentation
playbook covers Stages A-C (catalog mirroring, color/rotation/JPEG
augmentations, art-only crops). When those stop moving the eval needle,
Stage D fine-tunes the embedder itself on the operator-labeled corpus.

This doc covers Stage D end-to-end:

1. **Dataset spec** — what each row contains and why.
2. **Dataset export** — running `scripts/export-finetune-dataset.mjs`.
3. **Training infra options** — pick one before writing training code.
4. **Training contract** — what the training script must consume and
   produce so it slots back into our inference path without rewrites.
5. **Eval loop** — how to compare a fine-tuned model against the
   off-the-shelf baseline.

Stage D was scaffolded on **2026-04-28** with the dataset export +
this doc. The training script itself is still TODO — the export gives
us the data shape and lets us inspect quality before paying for GPUs.

---

## When to enter Stage D

From the augmentation playbook:

> Plan to collect ~500 labeled scans before starting that project.

As of 2026-04-28 we have **277** anchors across **92** distinct cards
with three condition variants each (clean / hand-held / corner-finger).
Below the 500-scan target, but the eval data has surfaced two failure
modes that augmentation can't fix:

- **Variant confusion** — Pikachu V vs Pikachu VMAX vs Pikachu ex
  cluster in CLIP space because off-the-shelf OpenCLIP keys on
  holographic-foil-portrait visual cues over character identity. No
  amount of catalog hygiene fixes this; the embedding manifold needs
  to be reshaped.
- **Lighthouse cards** — a single canonical embedding (e.g.
  `astral-radiance-102-hisuian-samurott-vstar`) acts as a magnet for
  many wrong photos. Same root cause: foil-bias over identity.

Both are exactly what contrastive fine-tuning with hard negatives is
designed to address.

---

## Dataset spec

One JSONL line per anchor user-photo. Schema:

```json
{
  "anchor_id": "uuid",
  "anchor_local_path": "images/<sha256>.jpg",
  "anchor_storage_path": "scan_eval/<sha256>.jpg",
  "anchor_hash": "sha256",
  "anchor_bytes_size": 12345,
  "captured_source": "user_photo",
  "captured_language": "EN",
  "notes": "clean | hand-held | corner-finger | …",
  "created_at": "2026-04-28T...",
  "positive": {
    "slug": "pokemon-go-27-pikachu",
    "canonical_name": "Pikachu",
    "set_name": "Pokémon GO",
    "card_number": "27",
    "language": "EN",
    "mirrored_primary_image_url": "https://nbveknrnvcgeyysqrtkl.supabase.co/.../full.png"
  },
  "hard_negatives": [
    {
      "slug": "ascended-heroes-57-pikachu-ex",
      "canonical_name": "Pikachu ex",
      "set_name": "Ascended Heroes",
      "card_number": "57",
      "mirrored_primary_image_url": "https://...",
      "source": "eval_confusion_pair"
    },
    {
      "slug": "pokemon-go-28-pikachu",
      "canonical_name": "Pikachu",
      "set_name": "Pokémon GO",
      "card_number": "28",
      "mirrored_primary_image_url": "https://...",
      "source": "variant_sibling"
    }
  ]
}
```

### Hard-negative sources

The export pipeline mines hard negatives from two sources, in priority
order:

1. **`eval_confusion_pair`** — actual mistakes from the most recent
   `scan_eval_runs.detailed_results`. If the model predicted X for
   anchor A, X is a hard negative — we have proof CLIP confuses them.
   These are the strongest signal we have and dominate the budget.
2. **`variant_sibling`** — same `canonical_name` but different slug
   (Pikachu V, Pikachu VMAX, Pikachu ex of any set). Even when the
   model gets the anchor right today, these are the expected confusion
   pairs we want pushed apart. Filled to half the remaining budget so
   confusions stay primary when both sources have data.

`source` is preserved on each hard-negative so the training script can
weight confusion-pair losses higher than variant-sibling losses if
desired (we don't yet — start with equal weights).

### Train/val split

Stratified by `positive.slug`: for each slug, ~20% of its photos go to
val and the rest to train. **No slug appears in both sets.** Eval
metrics measured on val therefore test generalization to the same
visual concept under different conditions, not memorization.

When a slug has only 1 photo, it goes to train (val would orphan it).
This keeps train/val ratios within ±1 photo per slug.

The split is deterministic — same `--seed` always yields the same
split, so two training runs on the same dataset are directly
comparable.

### Dataset version

The current schema is `scanner-finetune-v1`. The training script must
refuse to load any other version — bump the constant in
`scripts/export-finetune-dataset.mjs` if you change the row shape
incompatibly.

---

## Running the export

```zsh
# Default: ./data/finetune-<YYYY-MM-DD>/, 80/20 split, latest eval run
npm run dataset:export

# Custom out dir + larger val fraction:
npm run dataset:export -- --out ./data/finetune-2026-04-28 --val-frac 0.25

# Dry run to inspect stats without writing files:
npm run dataset:export -- --dry-run

# Skip JPEG downloads (fast schema check):
npm run dataset:export -- --no-anchor-download

# Use a specific eval run for hard-negative mining:
npm run dataset:export -- --eval-run 8adb3eaa-a805-4d0b-81d7-cd9185ce1fcb
```

Output structure:

```
data/finetune-<YYYY-MM-DD>/
├── manifest.json    # dataset version, flags, summary stats
├── train.jsonl      # ~80% of rows
├── val.jsonl        # ~20% (stratified by slug)
└── images/
    └── <sha256>.jpg # one anchor JPEG per unique image_hash
```

### Reading the manifest

The manifest captures everything needed to reproduce the run:

```json
{
  "dataset_version": "scanner-finetune-v1",
  "generated_at": "2026-04-28T...",
  "out_dir": "/abs/path/to/out",
  "confusion_run_id": "8adb3eaa-...",
  "flags": { "valFrac": 0.20, "maxHardNegs": 8, "seed": 42, ... },
  "stats": {
    "anchors_total": 277,
    "distinct_slugs": 92,
    "avg_hard_negatives": 6.4,
    "rows_with_confusion_negatives": 60,
    "rows_with_no_hard_negatives": 0,
    "distinct_conditions": ["clean", "hand-held", "corner-finger"]
  }
}
```

If `rows_with_no_hard_negatives > 0`, those anchors only have the
batch's other anchors as in-batch negatives during training — still
useful but contrastive signal is weaker. Investigate whether their
canonical names lack siblings in our catalog.

---

## Training infra options

The export is infra-agnostic. Pick one of these for the training
script (Stage D Step 2):

### Option 1: Modal (recommended for one-shot LoRA fine-tune)

- **Cost**: pay-per-second GPU. A100 ~$1.85/hr, T4 ~$0.59/hr.
- **Runtime**: ~30-60 min for a LoRA projection-head fine-tune on a
  T4 with ~277 anchors and CLIP ViT-L/14. Probably $1-3 per training
  run end-to-end.
- **Pros**: cheap, no infra to manage, Python-native, image build
  cached so subsequent runs are fast. Works great for iteration.
- **Cons**: no UI for inspecting training data — debug via logs and
  return-value JSON.
- **Setup**: Modal CLI + a `modal.Function` that mounts the dataset
  out-dir and runs the training script.

### Option 2: Lambda Labs (recommended for full ViT fine-tune)

- **Cost**: hourly GPU rental. A100 ~$1.10/hr (cheapest spot).
- **Runtime**: ~2-4 hr for a full ViT fine-tune at our dataset size.
  Probably $5-10 per training run.
- **Pros**: cheaper than Modal for long jobs; SSH + Jupyter for
  interactive debugging.
- **Cons**: provision-and-tear-down overhead; you pay for idle time
  between iterations.

### Option 3: Replicate fine-tune endpoint

- **Cost**: variable; their CLIP fine-tune endpoint is ~$0.03 per
  prediction in Modal/Lambda equivalents.
- **Pros**: same platform we already use for inference.
- **Cons**: their fine-tune surface is mostly aimed at SDXL/diffusion;
  CLIP fine-tunes are not first-class. Likely the worst ergonomics.

**Decision: Modal for v1 of the training script.** Cheapest dev
loop, easy to spin up, good for the projection-head LoRA approach we
should try first. If we outgrow it (need full-ViT fine-tune over 1000+
anchors), Lambda Labs is the next step.

---

## Training contract

Whatever training script we write has to round-trip with the rest of
the system. Contract:

### Inputs

- A `manifest.json` produced by `scripts/export-finetune-dataset.mjs`.
- The matching `train.jsonl` and `val.jsonl`.
- The `images/` directory.
- Catalog images downloaded on-demand from
  `positive.mirrored_primary_image_url` and
  `hard_negatives[*].mirrored_primary_image_url`.

### Outputs

- A serialized model checkpoint that conforms to ONE of:
  - **LoRA adapter weights** for OpenCLIP ViT-L/14, loadable via
    `peft` or open_clip's adapter API. Smallest, cheapest path.
  - **Full ViT-L/14 weights** in HF safetensors format. Use only if
    LoRA underperforms by >5% top-1.
  - **A small projection-head MLP** that maps off-the-shelf CLIP
    embeddings into a fine-tuned 768-dim space. Cheapest of all —
    inference becomes (existing CLIP embedding) → (projection MLP) →
    kNN against re-projected catalog embeddings.

- A `training-stats.json` with:
  - val top-1 accuracy at best checkpoint
  - per-epoch loss curve
  - hyperparameters used
  - elapsed wall time
  - dataset_version it was trained on
  - new `IMAGE_EMBEDDER_MODEL_VERSION` to bump in the codebase

### Inference deployment

After a fine-tune lands:

1. Bump `IMAGE_EMBEDDER_MODEL_VERSION` in `lib/ai/image-embedder.ts`
   to a new tag (e.g. `popalpha-clip-vitl14-v1`).
2. Run the existing image-embedding crons to re-embed the catalog
   under the new version. The cron filters by `model_version` so old
   embeddings stay queryable until the new ones land.
3. Update the kNN query in `app/api/scan/identify/route.ts` to filter
   on the new version (or run dual-version queries during cutover).
4. Re-run `npm run eval:run` against the new version. Compare top-1 +
   high-conf-wrong rate against the prior baseline.

If the new version doesn't beat the baseline by >2% top-1 OR doesn't
move high-conf-wrong rate, **don't deploy** — document the negative
result in this runbook and try a different recipe (more data,
different loss, different LoRA rank).

---

## Eval loop

Same harness as today — `npm run eval:run` — but with `--notes`
annotated to include the model_version and dataset commit:

```zsh
npm run eval:run -- \
  --notes "popalpha-clip-vitl14-v1 (LoRA, dataset commit abc123)"
```

The eval script auto-compares against the prior run on the same
endpoint and reports deltas. Track both:

- **top-1 accuracy** — does the fine-tune resolve confusion-pair
  failures? Goal: 70%+ on the 277-image corpus, 80%+ once the
  dataset hits 500.
- **high-conf-wrong rate** — does it reduce dangerous misses? Goal:
  <2% (current baseline ~23% pre-Track-A, ~0% post-Track-A on the
  baseline run).

Persist every fine-tuned-model eval in `scan_eval_runs` with the
model_version baked into the notes — the table doubles as our
fine-tune leaderboard.

---

## What's done as of 2026-04-28

- ✅ Dataset spec defined (this doc)
- ✅ `scripts/export-finetune-dataset.mjs` — JSONL emitter + anchor
  download + train/val split
- ✅ `npm run dataset:export` wired up
- ✅ Trust-contract entries in `scripts/security-guardrails.config.mjs`

## What's TODO

- [ ] Pick training infra (recommend Modal)
- [ ] Write `training/train.py` against the dataset format
- [ ] First fine-tune run + eval
- [ ] If green, integrate into the inference path (steps in "Inference
      deployment" above)
- [ ] Document fine-tune results back into this runbook (replacing
      the "What's done" / "What's TODO" sections with a results log)

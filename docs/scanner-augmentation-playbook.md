# Scanner Augmented Reference Index (Stage C) — Playbook

**Established**: 2026-04-24 after recipe v1 shipped.

## What this pattern is

The scanner identify pipeline embeds user-uploaded card photos via CLIP
and runs pgvector kNN against a reference index built from Scrydex
product shots. First-pass eval (2026-04-23) showed **0/12 top-1** against
real iPhone captures — the reference embeddings sat in one neighborhood
of CLIP space, user photos in a distinctly different one, and no amount
of threshold tuning bridged that gap.

Stage C fixes this by giving each canonical card **multiple reference
embeddings** that span common iPhone-capture conditions, all keyed under
the same `canonical_slug`. The identify route's kNN dedups by slug so
the closest-matching variant per card wins. Same embedder, same per-
query cost, but the reference set now samples more of the capture-
conditions distribution.

## Implementation anatomy

- `lib/ai/image-augmentations.ts` — defines variants (index, recipeId,
  transform fn). Bump `AUGMENTATION_RECIPE_VERSION` on any recipe change
  to invalidate existing variants via the `source_hash` field.
- `app/api/cron/augment-card-image-embeddings/route.ts` — per-slug,
  per-variant generate → upload → embed → upsert cron. Skips rows whose
  source_hash matches the current recipe. Idempotent.
- `lib/ai/card-image-embeddings.ts::ensureCardImageEmbeddingsSchema` —
  idempotent schema migration: single-column PK → composite
  `(canonical_slug, variant_index)`. Runs on first cron invocation.
- `app/api/scan/identify/route.ts` — kNN query wraps a `DISTINCT ON
  canonical_slug` over an overfetched-by-4× inner window so the top-K
  returned is per-card, not per-variant.

## Recipe v1 measurement (locked)

| | baseline (pre-Stage-C) | after v1 (partial drain, test slugs covered) |
|---|---|---|
| top-1 | 0/12 | **3/12** (+3) |
| top-5 | 2/12 | **7/12** (+5) |
| high conf | 2/12 | **5/12** (+3) |

Split by capture condition — this is the **most important finding**:

| | corner-held (user-held, thumb-on-corner) | flat/clean (on-surface, overhead light) |
|---|---|---|
| Δ top-1 | **0 → 0 (unchanged)** | **0 → 3** (50% of subset) |
| Δ top-5 | 2 → 2 (unchanged) | 2 → 5 (83% of subset) |

**Conclusion**: v1's variants (brightness/WB/rotate/JPEG) address
distribution mismatch but do not simulate hand occlusion. Corner-held
captures have a distinct failure mode.

## Known failure modes and next moves

### 1. Hand occlusion (unaddressed by v1)

Real users hold cards by the corner while scanning. V1's recipe
(brightness, ±5° rotate, JPEG compression) doesn't simulate a thumb or
finger occluding ~10–15% of the card. Corner-held shots still match
against unrelated cards at sim ~0.70.

**Fix**: Recipe v2 — add thumb-overlay variants (synthetic skin-tone
shape at bottom-right and top-left). Bump
`AUGMENTATION_RECIPE_VERSION` from `augv1` → `augv2` to force re-embed.

### 2. Cramorant → Pidgey persistent anomaly

Hop's Cramorant (Ascended Heroes #177) matches to Pidgey at high
confidence (sim 0.77, gap 0.02) on BOTH corner-held AND flat shots,
even after v1 augmentation. Stable bug across 4 eval runs.

**Diagnosis paths worth trying** (no decisive fix yet):
- Inspect the Scrydex reference image for visual anomalies (low
  contrast? unusual composition? already-compressed-heavily?).
- Check if any NEARBY slug in the index has a corrupt embedding
  pulling the cluster.
- Consider whether this specific card needs a stronger augmentation
  set or an OCR-on-collector-number tiebreaker.

### 3. Near-miss variant ambiguity

Wailord corner-held matched Wailord-from-Supreme-Victors. Right
character, wrong print. This is the variant-ambiguity case Phase 4
(OCR secondary signal on collector number) was scoped for. Not an
augmentation problem.

## Operational rules

- **Drain the scheduled cron first** after any recipe bump. The
  scheduled `*/5 min` cron drains slowly because of Replicate cold-
  start pressure; a manual cursor-based drain loop pushes through ~1k
  cards/hour vs ~200/hour scheduled.
- **Always re-run `npm run eval:run` after a recipe change.** The
  harness is the only objective measurement; human eyeballing of a
  few scans is not enough to tell whether the recipe helped.
- **Expand the eval corpus before the next big experiment.** 12 images
  is enough for directional signal but not for statistical confidence.
  Target: 50+ images covering more conditions (sleeved cards, glare,
  tilted, binder-through) before recipe v3.
- **Per-variant budget**: each new variant doubles the index size and
  adds ~$14 one-time Replicate cost at current catalog (~23k cards).
  Don't add variants speculatively; only when the eval harness proves
  the recipe closes a specific failure mode.

## When to escalate to Stage D (fine-tuning)

If recipe v2 + v3 don't push top-1 past ~50%, augmentation has hit
diminishing returns. Escalate to fine-tuning the embedder itself on
the accumulated eval corpus (user_correction rows in
`scan_eval_images` are labeled positive pairs). Plan to collect ~500
labeled scans before starting that project; we're at 12 as of this
doc.

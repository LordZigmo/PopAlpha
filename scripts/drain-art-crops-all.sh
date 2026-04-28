#!/usr/bin/env bash
#
# Full-catalog drain for the art-crop reference embeddings — every
# canonical_card with a mirrored image, no attention filter.
#
# Companion to scripts/drain-art-crops-attention.sh. Use this one when
# you want maximum coverage (~19K slugs, ~$28 one-time spend).
#
# Why both scripts: the attention variant is for fast targeted
# recovery (~$1, 30 min) on the 1,171 cards users actually look at.
# The all-catalog variant is for the longer-term goal of letting the
# multi-crop merge run in additive mode without art-noise concerns.
#
# Expected runtime: ~20-35 hours at the cron's current sequential
# Replicate cadence. Designed to run unattended — every transient
# failure path is handled (HTTP 000 / 502 / 504 retried; cold start
# tolerated; deadline truncation exits cleanly with progress).
#
# Usage:
#   export CRON_SECRET=...    # from .env.local
#   bash scripts/drain-art-crops-all.sh
#
# Resumable: kill it with Ctrl-C any time. Restarting walks past
# already-done slugs (skip-if-hash-matches) and continues fresh work.

set -u

if [ -z "${CRON_SECRET:-}" ]; then
  echo "ERROR: CRON_SECRET not set. Run: export CRON_SECRET=\$(grep '^CRON_SECRET=' .env.local | cut -d= -f2- | tr -d '\"')"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not installed. brew install jq"
  exit 1
fi

BASE_URL="https://popalpha.ai/api/cron/embed-card-art-crops"
LAST=""
TOTAL_GEN=0
TOTAL_SKIP=0
TOTAL_FAILED=0
# Bounded high so a long unattended drain has plenty of passes.
# Single-pass deadline-truncates at ~270s; ~50 generations per pass;
# 19000 / 50 = ~380 passes worst case. 1000 leaves ~3x headroom.
MAX_PASSES=1000

echo "drain start: full catalog, no attention filter"
echo "ETA: ~20-35 hours unattended"

for i in $(seq 1 $MAX_PASSES); do
  if [ -n "$LAST" ]; then
    URL="$BASE_URL?maxCards=200&cursor=$LAST"
  else
    URL="$BASE_URL?maxCards=200"
  fi

  RESPONSE=$(curl -s --retry 3 --retry-delay 10 --max-time 290 \
    -w "%{http_code}" -o /tmp/drain_body_$$.json \
    -H "Authorization: Bearer $CRON_SECRET" "$URL")
  HTTP_CODE="$RESPONSE"
  BODY=$(cat /tmp/drain_body_$$.json 2>/dev/null || echo "{}")
  rm -f /tmp/drain_body_$$.json

  if [ "$HTTP_CODE" != "200" ]; then
    echo "pass $i  HTTP $HTTP_CODE  body: $(echo "$BODY" | head -c 200)"
    if [ "$HTTP_CODE" = "401" ]; then
      echo "  -> auth failed. Check CRON_SECRET matches Vercel."
      exit 1
    fi
    if [ "$HTTP_CODE" = "504" ] || [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "000" ]; then
      echo "  -> transient, sleeping 30s before next pass..."
      sleep 30
      continue
    fi
    exit 1
  fi

  if ! echo "$BODY" | jq -e . >/dev/null 2>&1; then
    echo "pass $i  invalid JSON: $(echo "$BODY" | head -c 200)"
    exit 1
  fi

  GEN=$(echo "$BODY" | jq -r '.generated // 0')
  SKIP=$(echo "$BODY" | jq -r '.skipped // 0')
  FAILED=$(echo "$BODY" | jq -r '.failed // 0')
  PROCESSED=$(echo "$BODY" | jq -r '.processed // 0')
  NEW_LAST=$(echo "$BODY" | jq -r '.last_slug // ""')
  TRUNC=$(echo "$BODY" | jq -r '.truncatedAtDeadline // false')
  DUR=$(echo "$BODY" | jq -r '.durationMs // 0')

  TOTAL_GEN=$((TOTAL_GEN + GEN))
  TOTAL_SKIP=$((TOTAL_SKIP + SKIP))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  echo "pass $i  last=$NEW_LAST  gen=$GEN  skip=$SKIP  failed=$FAILED  trunc=$TRUNC  ms=$DUR  total_gen=$TOTAL_GEN"

  # Catalog exhausted: cron returned a short page (rows < pageSize)
  # which means we walked off the end of canonical_cards. The cron
  # signals this by returning processed below maxCards AND
  # truncatedAtDeadline=false.
  if [ -z "$NEW_LAST" ] || [ "$NEW_LAST" = "null" ]; then
    echo "cursor exhausted at pass $i (no last_slug returned)"
    break
  fi
  if [ "$PROCESSED" -lt 200 ] && [ "$TRUNC" = "false" ]; then
    echo "catalog exhausted at pass $i (processed $PROCESSED < 200, no truncation)"
    break
  fi

  LAST="$NEW_LAST"
  sleep 2
done

echo ""
echo "drain summary:"
echo "  generated: $TOTAL_GEN"
echo "  skipped:   $TOTAL_SKIP"
echo "  failed:    $TOTAL_FAILED"

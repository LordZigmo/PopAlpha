#!/usr/bin/env bash
#
# One-shot drain for the art-crop reference embeddings, focused on
# the user-attention slug subset (viewed in 14d AND priced ≥ $5).
#
# Usage:
#   export CRON_SECRET=...    # from .env.local
#   bash scripts/drain-art-crops-attention.sh
#
# Designed for visible-on-failure operation — every failure path
# prints a diagnostic line, no silent exits.

set -u  # error on undefined vars (catches missing CRON_SECRET)

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
MAX_PASSES=50

echo "drain start: focused on attention slug subset (~1,168 slugs)"

for i in $(seq 1 $MAX_PASSES); do
  if [ -n "$LAST" ]; then
    URL="$BASE_URL?priority=attention_only&maxCards=200&cursor=$LAST"
  else
    URL="$BASE_URL?priority=attention_only&maxCards=200"
  fi

  # --retry 3 + --retry-delay 10: curl auto-retries on transient
  # network / DNS / connection errors AND HTTP 408 / 429 / 5xx.
  # Catches the HTTP 000 connection-dropped case that the explicit
  # post-curl retry block below missed. --max-time 290 caps the
  # outer wait per attempt so a stuck connection can't block the
  # script forever.
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
    # 504 / 502 / 000: curl already retried 3x. Give it one more
    # script-level breather then continue — drain is idempotent so
    # a single missed pass is fine.
    if [ "$HTTP_CODE" = "504" ] || [ "$HTTP_CODE" = "502" ] || [ "$HTTP_CODE" = "000" ]; then
      echo "  -> transient, sleeping 30s before next pass..."
      sleep 30
      continue
    fi
    exit 1
  fi

  # Validate JSON before parsing — defends against deploy-in-progress
  # HTML pages that get a 200 status.
  if ! echo "$BODY" | jq -e . >/dev/null 2>&1; then
    echo "pass $i  invalid JSON: $(echo "$BODY" | head -c 200)"
    exit 1
  fi

  GEN=$(echo "$BODY" | jq -r '.generated // 0')
  SKIP=$(echo "$BODY" | jq -r '.skipped // 0')
  FAILED=$(echo "$BODY" | jq -r '.failed // 0')
  POS=$(echo "$BODY" | jq -r '.attention_position // 0')
  TOTAL=$(echo "$BODY" | jq -r '.attention_total // 0')
  NEW_LAST=$(echo "$BODY" | jq -r '.last_slug // ""')
  TRUNC=$(echo "$BODY" | jq -r '.truncatedAtDeadline // false')
  DUR=$(echo "$BODY" | jq -r '.durationMs // 0')

  TOTAL_GEN=$((TOTAL_GEN + GEN))
  TOTAL_SKIP=$((TOTAL_SKIP + SKIP))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  echo "pass $i  pos=$POS/$TOTAL  gen=$GEN  skip=$SKIP  failed=$FAILED  trunc=$TRUNC  ms=$DUR"

  # End conditions
  if [ "$POS" -ge "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo "drained: walked all $TOTAL attention slugs"
    break
  fi
  if [ -z "$NEW_LAST" ] || [ "$NEW_LAST" = "null" ]; then
    echo "cursor exhausted at pass $i (no last_slug returned)"
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

#!/usr/bin/env bash
# Watch a PR for new Codex review activity. Self-stops on merge/close.
#
# Designed to be wrapped by the Monitor tool from inside a Claude agent
# session so each new Codex inline comment / review surfaces as a chat
# notification, eliminating the need for the user to manually relay
# "Codex responded."
#
# Usage (standalone — outputs to stdout):
#   ./scripts/watch-pr-codex.sh <pr-number>
#
# Usage (inside Claude — invoke via Monitor tool with persistent=true):
#   Monitor({
#     description: "Codex review + merge watcher for PR #<N>",
#     persistent: true,
#     timeout_ms: 3600000,
#     command: "bash scripts/watch-pr-codex.sh <N>",
#   })
#
# Each NEW Codex inline comment / review submission prints one line.
# When the PR is MERGED or CLOSED, prints a final "exiting" line and
# the loop exits. Default poll interval: 30s.
#
# Env overrides:
#   REPO=<owner>/<name>     defaults to "LordZigmo/PopAlpha"
#   POLL_INTERVAL=<sec>     defaults to 30
#
# Requires: gh CLI authenticated to the target repo.

set -uo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "[watch-pr-codex] usage: $0 <pr-number>" >&2
  exit 2
fi
REPO="${REPO:-LordZigmo/PopAlpha}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[watcher] armed for PR #$PR (repo=$REPO, poll=${POLL_INTERVAL}s) since $since (will self-stop on merge/close)"

while true; do
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Capture exit codes per-endpoint so the cursor only advances when both
  # polls succeed. Without this guard, a transient gh / network / rate-
  # limit failure would silently drop any Codex activity in the failure
  # window: cursor would advance past the lost comments and the next
  # successful poll's "created_at > $since" filter would skip them
  # forever. Codex P2 caught this on PR #61.
  comments_out=$(
    gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq \
      ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.created_at > \"$since\") | \"[Codex inline #\(.id)] \(.path):\(.line // .original_line // 0) (commit \(.commit_id[:10])) — \(.body | split(\"\\n\")[0] | .[:240])\"" \
      2>/dev/null
  )
  comments_ok=$?

  # GitHub returns reviews chronologically (oldest first), so --paginate
  # is required to surface the latest on long-iteration PRs.
  reviews_out=$(
    gh api "repos/$REPO/pulls/$PR/reviews" --paginate --jq \
      ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.submitted_at > \"$since\") | \"[Codex review] commit=\(.commit_id[:10]) state=\(.state) submitted=\(.submitted_at)\"" \
      2>/dev/null
  )
  reviews_ok=$?

  # Emit only when the call succeeded AND produced output.
  if [ $comments_ok -eq 0 ] && [ -n "$comments_out" ]; then echo "$comments_out"; fi
  if [ $reviews_ok -eq 0 ] && [ -n "$reviews_out" ]; then echo "$reviews_out"; fi

  # Self-stop on merge/close (independent — failure here just means we
  # keep polling next iteration, which is the right thing).
  state=$(gh pr view "$PR" -R "$REPO" --json state --jq '.state' 2>/dev/null || echo "")
  case "$state" in
    MERGED)
      echo "[watcher] PR #$PR MERGED — exiting"
      exit 0
      ;;
    CLOSED)
      echo "[watcher] PR #$PR CLOSED (not merged) — exiting"
      exit 0
      ;;
  esac

  # Advance the cursor only after BOTH activity-polls succeeded.
  # If either failed, leave $since pinned to the earlier timestamp so
  # the next iteration re-fetches the failure-window range.
  if [ $comments_ok -eq 0 ] && [ $reviews_ok -eq 0 ]; then
    since="$now"
  fi

  sleep "$POLL_INTERVAL"
done

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

  # New Codex inline review comments
  gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq \
    ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.created_at > \"$since\") | \"[Codex inline #\(.id)] \(.path):\(.line // .original_line // 0) (commit \(.commit_id[:10])) — \(.body | split(\"\\n\")[0] | .[:240])\"" \
    2>/dev/null || true

  # New Codex review submissions. --paginate is critical: GitHub returns
  # reviews in chronological order (oldest first), so without pagination
  # only the first 30 are visible. On long-iteration PRs the latest
  # Codex review would live on page 2+ and the watcher would go silent.
  # Codex P2 caught this on PR #61.
  gh api "repos/$REPO/pulls/$PR/reviews" --paginate --jq \
    ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.submitted_at > \"$since\") | \"[Codex review] commit=\(.commit_id[:10]) state=\(.state) submitted=\(.submitted_at)\"" \
    2>/dev/null || true

  # Self-stop on merge/close
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

  since=$now
  sleep "$POLL_INTERVAL"
done

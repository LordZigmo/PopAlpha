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

# Cursor strategy: track per-endpoint MAX ID (monotonically increasing
# integers) instead of timestamps. Solves two problems caught by Codex
# review on PR #61:
#   - Second-boundary race (P2): GitHub timestamps are second-precision,
#     so a strict `created_at > $since` filter can miss a comment posted
#     in the same UTC second as the previous poll's `now`. IDs don't
#     have boundary issues.
#   - Duplicate emission on partial failure (P3): per-endpoint cursors
#     advance independently when each call succeeds. If reviews fails
#     while comments succeeds, comments emits + advances, reviews stays
#     pinned. Next iteration re-fetches reviews from its old cursor
#     without re-emitting the already-printed comments.
#
# Bootstrap: capture the current max IDs at startup so the watcher only
# emits activity that lands AFTER it armed (not the PR's full history).

bootstrap_max_id() {
  local endpoint="$1" # "comments" or "reviews"
  # NOTE: `gh api --paginate --jq EXPR` runs the jq filter ONCE PER PAGE
  # and concatenates the outputs as a multi-value stream. A `max // 0`
  # inside jq would emit one max per page, so on a long-iteration PR
  # (>1 page of Codex activity) the captured value becomes a multi-line
  # string like "1234\n5678" — which then breaks the `select(.id > $X)`
  # filter when interpolated. Codex P2 caught this on PR #61.
  #
  # Workaround: emit raw IDs (one per line) and take the max in shell
  # via `sort -nr | head -1`. Single max regardless of page count.
  gh api "repos/$REPO/pulls/$PR/$endpoint" --paginate --jq \
    '.[] | select(.user.login == "chatgpt-codex-connector[bot]") | .id' \
    2>/dev/null | sort -nr | head -1
}

last_comment_id="$(bootstrap_max_id comments)"
[ -z "$last_comment_id" ] && last_comment_id=0
last_review_id="$(bootstrap_max_id reviews)"
[ -z "$last_review_id" ] && last_review_id=0

echo "[watcher] armed for PR #$PR (repo=$REPO, poll=${POLL_INTERVAL}s) — cursor: comments>$last_comment_id reviews>$last_review_id (will self-stop on merge/close)"

while true; do
  # Comments. Each emitted line is `<id>\t<printable>` so we can
  # advance per-row and never re-emit.
  comments_raw=$(
    gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq \
      ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.id > $last_comment_id) | \"\(.id)\\t[Codex inline #\(.id)] \(.path):\(.line // .original_line // 0) (commit \(.commit_id[:10])) — \(.body | split(\"\\n\")[0] | .[:240])\"" \
      2>/dev/null
  )
  comments_ok=$?
  if [ $comments_ok -eq 0 ] && [ -n "$comments_raw" ]; then
    while IFS=$'\t' read -r cid line; do
      [ -z "$cid" ] && continue
      echo "$line"
      if [ "$cid" -gt "$last_comment_id" ]; then last_comment_id="$cid"; fi
    done <<< "$comments_raw"
  fi

  # Reviews. Same per-row id advancement.
  reviews_raw=$(
    gh api "repos/$REPO/pulls/$PR/reviews" --paginate --jq \
      ".[] | select(.user.login == \"chatgpt-codex-connector[bot]\") | select(.id > $last_review_id) | \"\(.id)\\t[Codex review] commit=\(.commit_id[:10]) state=\(.state) submitted=\(.submitted_at)\"" \
      2>/dev/null
  )
  reviews_ok=$?
  if [ $reviews_ok -eq 0 ] && [ -n "$reviews_raw" ]; then
    while IFS=$'\t' read -r rid line; do
      [ -z "$rid" ] && continue
      echo "$line"
      if [ "$rid" -gt "$last_review_id" ]; then last_review_id="$rid"; fi
    done <<< "$reviews_raw"
  fi

  # Self-stop on merge/close. Independent — failure here just means we
  # skip the check this iteration and try again next time.
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

  sleep "$POLL_INTERVAL"
done

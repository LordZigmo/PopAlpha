<wizard-report>
# PostHog post-wizard report

This pass closed the gap on **server-authoritative subscription analytics** — events that can't be tracked client-side. PostHog was already wired (posthog-js + posthog-node, Clerk identify/reset, ~12 server events, full iOS paywall funnel).

## Events added

| Event | File |
|---|---|
| `subscription_verified_server` | `app/api/iap/verify/route.ts` |
| `subscription_verification_failed` | `app/api/iap/verify/route.ts` |
| `subscription_status_changed` | `app/api/webhooks/apple/notifications/route.ts` |
| `pro_signals_accessed` | `app/api/pro/signals/route.ts` |

`subscription_verification_failed` carries a `reason` property: `jws_verification` / `internal_error` / `missing_fields` / `unrecognized_environment` / `upsert_failed`.

`subscription_status_changed` distinct ID is `clerk_user_id` from the apple_subscriptions row, falling back to `anonymous:<original_transaction_id>` if the row was deleted.

All events use `auth.userId` (Clerk userId) as distinct ID — same identity space as the iOS- and web-side events, so funnels join cleanly.

## Dashboard

[Analytics basics](https://us.posthog.com/project/391820/dashboard/1559138)

- [Paywall conversion funnel](https://us.posthog.com/project/391820/insights/RsDChEvG) — `paywall_viewed` → `paywall_subscribe_tapped` → `paywall_subscribed` (iOS) → `subscription_verified_server` (server). Drop from step 3 to step 4 should be near zero.
- [Subscription lifecycle by status](https://us.posthog.com/project/391820/insights/oIcwaxQE) — `subscription_status_changed` broken down by status. Watch billing_retry for failed payments.
- [Verification failures by reason](https://us.posthog.com/project/391820/insights/XKSUeIvh) — receipt validation failures broken down by failure mode.
- [Pro feature engagement](https://us.posthog.com/project/391820/insights/NwbsY0F0) — `pro_signals_accessed` total + DAU. Low engagement = churn risk.
- [Paywall surface volume + conversion](https://us.posthog.com/project/391820/insights/XYHSC4IV) — views vs subscribes per surface. Spot over-firing or under-utilized triggers.

### Agent skill

Skill folder at `.claude/skills/integration-nextjs-app-router/` for further PostHog work in Claude Code.

</wizard-report>

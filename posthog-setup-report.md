<wizard-report>
# PostHog post-wizard report

The wizard has completed a follow-up integration of PostHog event tracking on top of the existing analytics infrastructure in PopAlpha (Next.js + iOS).

PostHog was already deeply wired before this pass — `posthog-js` and `posthog-node` installed; `lib/posthog-server.ts` exposing a singleton `getPostHogClient()`; `instrumentation.ts` registering an OpenTelemetry span processor for AI / LLM tracing; `instrumentation-client.ts` and `components/posthog-provider.tsx` initializing posthog-js and synchronizing Clerk userId via `posthog.identify()` / `posthog.reset()`. About a dozen API routes were already firing typed server-side events (`activity_liked`, `holding_edited`, `card_wishlisted`, `waitlist_joined`, `handle_claimed`, etc.). On the iOS side, `AnalyticsService` was firing the full paywall funnel (`paywall_viewed`, `paywall_subscribe_tapped`, `paywall_subscribed`, `paywall_dismissed`, `paywall_restore_succeeded`, `paywall_purchase_failed`).

The gap closed in this pass was **server-authoritative subscription analytics** — events that cannot or should not be tracked client-side. Four new events were instrumented across three API routes:

| Event | Description | File |
|---|---|---|
| `subscription_verified_server` | Server-side confirmation that a StoreKit purchase JWS was verified and the apple_subscriptions row was upserted. Authoritative complement to the client-side `paywall_subscribed` event — a discrepancy (client fires, server doesn't) signals receipt-tampering or a network failure during /api/iap/verify. | `app/api/iap/verify/route.ts` |
| `subscription_verification_failed` | Server rejected an iOS-side StoreKit JWS receipt — bad signature, wrong bundle id, environment mismatch, missing fields, or upsert failure. Captures Apple-rejected purchases that the client thinks succeeded. Critical diagnostic for production receipt-validation issues. Carries a `reason` property: `jws_verification` / `internal_error` / `missing_fields` / `unrecognized_environment` / `upsert_failed`. | `app/api/iap/verify/route.ts` |
| `subscription_status_changed` | App Store Server Notification V2 webhook update — DID_RENEW / EXPIRED / REVOKE / REFUND / GRACE_PERIOD_EXPIRED / etc. Subscription lifecycle events that cannot be tracked client-side. Drives churn / renewal / refund analytics. Distinct ID is `clerk_user_id` looked up from the apple_subscriptions row, falling back to an `anonymous:<original_transaction_id>` namespace if the row was deleted. | `app/api/webhooks/apple/notifications/route.ts` |
| `pro_signals_accessed` | Pro user fetched variant-level signal data via /api/pro/signals. Engagement metric for the headline Pro feature — measures how often paying users actually exercise the gated capability they're paying for. Low engagement among pro users is a churn leading indicator. | `app/api/pro/signals/route.ts` |

Distinct IDs use `auth.userId` (Clerk userId) — same identity space as the existing iOS-side and web-side events, so funnels join cleanly without an explicit `alias` step.

## Next steps

We've built a dashboard with five insights so you can keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard** — [Analytics basics](https://us.posthog.com/project/391820/dashboard/1559138)
- **Paywall conversion funnel (client → server)** — [RsDChEvG](https://us.posthog.com/project/391820/insights/RsDChEvG) — 4-step funnel from `paywall_viewed` → `paywall_subscribe_tapped` → `paywall_subscribed` (iOS) → `subscription_verified_server` (server). Broken down by `surface`. The drop from step 3 to step 4 should be near zero — if it's not, there's a trust-signal anomaly worth investigating.
- **Subscription lifecycle by status** — [oIcwaxQE](https://us.posthog.com/project/391820/insights/oIcwaxQE) — Trends of `subscription_status_changed` broken down by `status` (active / expired / revoked / grace_period / billing_retry). Active = renewals + new subs. Expired/revoked = churn. Watch for billing_retry spikes (failed payments).
- **Verification failures by reason** — [XKSUeIvh](https://us.posthog.com/project/391820/insights/XKSUeIvh) — Bar chart of `subscription_verification_failed` broken down by `reason`. Diagnostic for production receipt validation. Each reason maps to a specific failure mode in the IAP backend.
- **Pro feature engagement — signals accessed** — [NwbsY0F0](https://us.posthog.com/project/391820/insights/NwbsY0F0) — Total + DAU lines for `pro_signals_accessed`. Cross-reference with `subscription_status_changed[status=expired]` to identify pro users likely to churn (low feature engagement → churn risk).
- **Paywall surface volume + conversion** — [XYHSC4IV](https://us.posthog.com/project/391820/insights/XYHSC4IV) — `paywall_viewed` vs `paywall_subscribed` broken down by `surface`. High-volume + low-conversion surfaces (a too-eager auto-trigger) and low-volume + high-conversion surfaces (an under-utilized opportunity) are both visible at a glance.

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>

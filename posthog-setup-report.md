<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into PopAlpha. The existing infrastructure (posthog-js + posthog-node packages, instrumentation-client.ts init, lib/posthog-server.ts server client, reverse proxy in next.config.ts, and user identification in the onboarding flow) was already in place. This pass added 7 new server-side events across 5 API routes, covering social actions, portfolio management, wishlist activity, and data portability — rounding out the coverage of all key user actions in the app.

| Event | Description | File |
|---|---|---|
| `user_followed` | User successfully followed another user | `app/api/profile/follow/route.ts` |
| `user_unfollowed` | User successfully unfollowed another user | `app/api/profile/follow/route.ts` |
| `card_wishlisted` | User added a card to their wishlist | `app/api/wishlist/route.ts` |
| `card_unwishlisted` | User removed a card from their wishlist | `app/api/wishlist/route.ts` |
| `data_exported` | User exported their full account data | `app/api/me/export/route.ts` |
| `holding_edited` | User edited an existing portfolio holding | `app/api/holdings/route.ts` |
| `holdings_bulk_imported` | User bulk-imported holdings from CSV | `app/api/holdings/bulk-import/route.ts` |

Pre-existing events already instrumented (not duplicated): `card_unwatched`, `cert_unwatched`, `handle_claimed`, `waitlist_joined`, `profile_updated`, `post_created`, `post_deleted`, `holding_added`, `activity_liked`, `private_sale_logged`.

## LLM analytics

LLM analytics were added via OpenTelemetry + `@posthog/ai`. Every Gemini call (`generateText`) now emits a `$ai_generation` event to PostHog's LLM analytics tab automatically, capturing model name, input/output tokens, latency, and cost. The Vercel AI SDK's `experimental_telemetry` option is used at each call site, and the OpenTelemetry SDK is initialized in `instrumentation.ts` (Next.js server-side instrumentation hook).

**New packages installed:** `@posthog/ai`, `@opentelemetry/sdk-node`, `@opentelemetry/resources`

**New file:** `instrumentation.ts` — registers the `PostHogSpanProcessor` on Next.js server startup, routing `gen_ai.*` OTel spans to PostHog.

| LLM call site | Function ID | User linked? | File |
|---|---|---|---|
| Card market summary | `card-profile-summary` | No (system cache) | `lib/ai/card-profile-summary.ts` |
| Homepage AI brief | `homepage-brief` | No (cron job) | `lib/ai/homepage-brief.ts` |
| Personalized card explanation | `personalized-card-explanation` | No (system) | `lib/personalization/explanation/llm.ts` |
| Card analysis (Scout) | `card-analysis` | Yes (`posthog_distinct_id` from Clerk `auth()`) | `app/actions/analyze.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard — Analytics basics**: https://us.posthog.com/project/391820/dashboard/1494566
- **Onboarding conversion funnel** (waitlist → handle → first holding): https://us.posthog.com/project/391820/insights/ILG8HBSS
- **Core engagement events (30 days)**: https://us.posthog.com/project/391820/insights/0oCSptUP
- **Portfolio activity trend** (adds, edits, CSV imports): https://us.posthog.com/project/391820/insights/baawEtUP
- **Private sales logged over time**: https://us.posthog.com/project/391820/insights/0dM0fmaP
- **Churn signals** (watchlist & wishlist removals): https://us.posthog.com/project/391820/insights/rcgNrsp9
- **LLM analytics** (generations, traces, costs): https://us.posthog.com/project/391820/llm-analytics/generations

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>

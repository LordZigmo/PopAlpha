export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The PostHog token is loaded into process.env from .env.local by Next.js
  // AFTER instrumentation.ts runs in some local-dev configurations. If it's
  // not present, skip OTel rather than crashing the entire dev server. In
  // prod the token is guaranteed via Vercel env, so the SDK starts normally.
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!apiKey) return;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { PostHogSpanProcessor } = await import("@posthog/ai/otel");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": "popalpha",
    }),
    spanProcessors: [
      new PostHogSpanProcessor({
        apiKey,
        host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      }),
    ],
  });

  sdk.start();
}

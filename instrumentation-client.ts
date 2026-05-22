import posthog from "posthog-js";

declare global {
  interface Window {
    __POSTHOG_INITIALIZED__?: boolean;
    posthog?: typeof posthog;
  }
}

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (typeof window !== "undefined" && token && !window.__POSTHOG_INITIALIZED__) {
  posthog.init(token, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
  });
  window.__POSTHOG_INITIALIZED__ = true;
  window.posthog = posthog as unknown as Window["posthog"];
}

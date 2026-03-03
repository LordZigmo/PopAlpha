import webpush, { type PushSubscription } from "web-push";

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

function getPushConfig() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@popalpha.ai";

  if (!publicKey || !privateKey) return null;

  return { publicKey, privateKey, subject };
}

export function isWebPushConfigured(): boolean {
  return !!getPushConfig();
}

function ensureConfigured() {
  const config = getPushConfig();
  if (!config) {
    throw new Error("Web push is not configured. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return config;
}

export async function sendWebPush(subscription: PushSubscription, payload: PushPayload) {
  ensureConfigured();
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

"use client";

import { useEffect, useMemo, useState } from "react";

type PushStatusResponse = {
  ok: boolean;
  configured?: boolean;
  hasSubscription?: boolean;
  subscriptionCount?: number;
  vapidPublicKey?: string | null;
  error?: string;
};

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }

  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

function detectPlatform(): string {
  const ua = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (isIos && standalone) return "ios-pwa";
  if (isIos) return "ios-browser";
  if (/android/.test(ua)) return "android";
  return "web";
}

export default function PushNotificationToggle() {
  const [supported, setSupported] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [enabled, setEnabled] = useState(false);
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);

  const platform = useMemo(() => {
    if (typeof window === "undefined") return "web";
    return detectPlatform();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasSupport =
      window.isSecureContext &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;

    setSupported(hasSupport);
    if ("Notification" in window) setPermission(Notification.permission);

    let cancelled = false;

    void fetch("/api/me/push", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as PushStatusResponse;
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Could not load push settings.");
        }

        if (cancelled) return;

        setConfigured(!!payload.configured);
        setVapidPublicKey(payload.vapidPublicKey ?? null);
        setSubscriptionCount(payload.subscriptionCount ?? 0);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Could not load push settings.");
        }
      });

    if (!hasSupport) return () => {
      cancelled = true;
    };

    void navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => {
        if (!cancelled) setEnabled(!!subscription);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function enablePush() {
    if (!supported) {
      setError("Push notifications are not supported on this device yet.");
      return;
    }
    if (!configured || !vapidPublicKey) {
      setError("Push notifications are not configured yet. Add your VAPID keys first.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      let nextPermission = permission;

      if (nextPermission !== "granted") {
        nextPermission = await Notification.requestPermission();
        setPermission(nextPermission);
      }

      if (nextPermission !== "granted") {
        throw new Error("Notification permission was not granted.");
      }

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey),
        });
      }

      const response = await fetch("/api/me/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          platform,
        }),
      });

      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not save this device for push notifications.");
      }

      setEnabled(true);
      setSubscriptionCount((current) => Math.max(1, current));
      setNotice(platform === "ios-browser" ? "Permission is on. Add PopAlpha to your Home Screen to receive iPhone push alerts." : "Push notifications are enabled on this device.");
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : "Could not enable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    if (!supported) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      if (!registration) {
        setEnabled(false);
        setSubscriptionCount(0);
        setNotice("Push notifications are off on this device.");
        return;
      }
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await fetch("/api/me/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setEnabled(false);
      setSubscriptionCount(0);
      setNotice("Push notifications are off on this device.");
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : "Could not disable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTestPush() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/me/push/test", {
        method: "POST",
      });

      const payload = (await response.json()) as { ok: boolean; delivered?: number; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Could not send a test notification.");
      }

      setNotice(`Test notification sent to ${payload.delivered ?? 0} device${(payload.delivered ?? 0) === 1 ? "" : "s"}.`);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Could not send a test notification.");
    } finally {
      setBusy(false);
    }
  }

  const helperText = !supported
    ? "This browser does not expose the Push API. On iPhone, install PopAlpha to your Home Screen first."
    : platform === "ios-browser"
      ? "iPhone push works after you add PopAlpha to your Home Screen and allow notifications there."
      : "Enable push on this device to receive PopAlpha alerts even when the app is closed.";

  return (
    <div className="rounded-[1.2rem] border border-[#1E1E1E] bg-[#090909] px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[16px] font-semibold text-white">Push notifications</p>
          <p className="mt-1 text-[13px] leading-6 text-[#8A8A8A]">{helperText}</p>
          <p className="mt-2 text-[12px] text-[#6B6B6B]">
            Status: {enabled ? "On" : "Off"}
            {subscriptionCount > 0 ? ` • ${subscriptionCount} saved device${subscriptionCount === 1 ? "" : "s"}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          {enabled ? (
            <>
              <button
                type="button"
                onClick={sendTestPush}
                disabled={busy || !configured}
                className="rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1] disabled:opacity-60"
              >
                Send Test
              </button>
              <button
                type="button"
                onClick={disablePush}
                disabled={busy}
                className="rounded-2xl border border-[#1E1E1E] px-4 py-2 text-[13px] font-semibold text-[#A3A3A3] transition hover:text-white disabled:opacity-60"
              >
                Turn Off
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={enablePush}
              disabled={busy || !supported}
              className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12] disabled:opacity-60"
            >
              Turn On
            </button>
          )}
        </div>
      </div>

      {permission === "denied" ? (
        <p className="mt-3 text-[12px] text-[#FF8A80]">Notifications are blocked in your browser settings.</p>
      ) : null}
      {error ? <p className="mt-3 text-[12px] text-[#FF8A80]">{error}</p> : null}
      {notice ? <p className="mt-3 text-[12px] text-[#9CCBFF]">{notice}</p> : null}
    </div>
  );
}

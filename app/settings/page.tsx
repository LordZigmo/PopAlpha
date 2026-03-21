"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SignOutButton } from "@clerk/nextjs";
import { useSafeUser } from "@/lib/auth/use-safe-user";
import PricingModal from "@/components/billing/pricing-modal";
import PushNotificationToggle from "@/components/settings/push-notification-toggle";
import ThemeToggle from "@/components/theme-toggle";

type SettingsResponse = {
  ok: boolean;
  settings?: {
    handle: string | null;
    notify_price_alerts: boolean;
    notify_weekly_digest: boolean;
    notify_product_updates: boolean;
    profile_visibility: "PUBLIC" | "PRIVATE";
  };
  error?: string;
};

type SettingsDraft = {
  handle: string | null;
  notify_price_alerts: boolean;
  notify_weekly_digest: boolean;
  notify_product_updates: boolean;
  profile_visibility: "PUBLIC" | "PRIVATE";
};

const DEFAULT_SETTINGS: SettingsDraft = {
  handle: null,
  notify_price_alerts: true,
  notify_weekly_digest: true,
  notify_product_updates: false,
  profile_visibility: "PUBLIC",
};

const STRIPE_PORTAL_URL = process.env.NEXT_PUBLIC_STRIPE_PORTAL_URL;

function getTierLabel(value: unknown): "Trainer" | "Ace" | "Elite" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "elite") return "Elite";
  if (normalized === "ace") return "Ace";
  return "Trainer";
}

function SettingToggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[16px] font-semibold text-white">{title}</p>
        <p className="mt-1 text-[13px] leading-6 text-[#8A8A8A]">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-7 w-12 shrink-0 rounded-full border transition",
          checked ? "border-[#305DE8] bg-[#1D4ED8]" : "border-[#1E1E1E] bg-white/[0.06]",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-1 h-5 w-5 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.28)] transition",
            checked ? "left-6" : "left-1",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { user, isLoaded } = useSafeUser();
  const [settings, setSettings] = useState<SettingsDraft>(DEFAULT_SETTINGS);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);

  useEffect(() => {
    if (!isLoaded || !user) return;
    let cancelled = false;

    setLoadingSettings(true);
    setSettingsError(null);

    void fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as SettingsResponse;
        if (!response.ok || !payload.settings) {
          throw new Error(payload.error || "Could not load settings.");
        }
        if (!cancelled) {
          setSettings(payload.settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : "Could not load settings.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSettings(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user]);

  const currentTier = useMemo(() => {
    if (!user) return "Trainer";
    return getTierLabel(
      user.publicMetadata.subscriptionTier ?? user.publicMetadata.tier ?? user.publicMetadata.plan,
    );
  }, [user]);

  const publicProfileHref = settings.handle ? `/u/${encodeURIComponent(settings.handle)}` : null;

  async function saveSettings() {
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsNotice(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notifyPriceAlerts: settings.notify_price_alerts,
          notifyWeeklyDigest: settings.notify_weekly_digest,
          notifyProductUpdates: settings.notify_product_updates,
          profileVisibility: settings.profile_visibility,
        }),
      });

      const payload = (await response.json()) as SettingsResponse;
      if (!response.ok || !payload.settings) {
        throw new Error(payload.error || "Could not save settings.");
      }

      setSettings(payload.settings);
      setSettingsNotice("Settings saved.");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Could not save settings.");
    } finally {
      setSavingSettings(false);
    }
  }

  if (!isLoaded) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[2rem] border border-[#1E1E1E] bg-[#101010] p-6">
          <div className="h-6 w-40 animate-pulse rounded-full bg-white/[0.06]" />
          <div className="mt-6 h-20 animate-pulse rounded-[1.5rem] bg-white/[0.04]" />
          <div className="mt-4 h-20 animate-pulse rounded-[1.5rem] bg-white/[0.04]" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <div className="rounded-[2rem] border border-[#1E1E1E] bg-[#101010] px-6 py-8 text-center">
          <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-white">Settings</h1>
          <p className="mt-3 text-[14px] leading-6 text-[#A3A3A3]">
            Sign in to manage your PopAlpha account settings.
          </p>
          <Link
            href="/sign-in"
            className="mt-5 inline-flex rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-white/[0.1]"
          >
            Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[2rem] border border-[#1E1E1E] bg-[#101010] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">Account</p>
              <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.04em] text-white">Settings</h1>
              <p className="mt-2 text-[14px] leading-6 text-[#A3A3A3]">
                Control notifications, billing, and who can see your PopAlpha profile.
              </p>
            </div>
            <Link
              href="/profile"
              className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
            >
              Back to Profile
            </Link>
          </div>

          <div className="mt-6 space-y-4">
            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Appearance</p>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[16px] font-semibold text-white">Theme</p>
                  <p className="mt-1 text-[13px] text-[#8A8A8A]">Switch between the available PopAlpha display styles.</p>
                </div>
                <ThemeToggle />
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Notifications</p>
              <div className="mt-4 space-y-5">
                <PushNotificationToggle />
                <SettingToggle
                  title="Price alerts"
                  description="Get pinged when tracked cards move enough to matter."
                  checked={settings.notify_price_alerts}
                  onChange={(next) => {
                    setSettings((current) => ({ ...current, notify_price_alerts: next }));
                    setSettingsNotice(null);
                  }}
                />
                <SettingToggle
                  title="Weekly digest"
                  description="Receive a weekly snapshot of what your cards and watched names did."
                  checked={settings.notify_weekly_digest}
                  onChange={(next) => {
                    setSettings((current) => ({ ...current, notify_weekly_digest: next }));
                    setSettingsNotice(null);
                  }}
                />
                <SettingToggle
                  title="Product updates"
                  description="Hear about major feature launches and new intelligence tools."
                  checked={settings.notify_product_updates}
                  onChange={(next) => {
                    setSettings((current) => ({ ...current, notify_product_updates: next }));
                    setSettingsNotice(null);
                  }}
                />
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Privacy</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[16px] font-semibold text-white">Profile visibility</p>
                  <p className="mt-1 text-[13px] leading-6 text-[#8A8A8A]">
                    Public profiles can be viewed by handle. Private profiles stay visible only to you.
                  </p>
                </div>
                <select
                  value={settings.profile_visibility}
                  onChange={(event) => {
                    setSettings((current) => ({
                      ...current,
                      profile_visibility: event.target.value as "PUBLIC" | "PRIVATE",
                    }));
                    setSettingsNotice(null);
                  }}
                  className="rounded-2xl border border-[#1E1E1E] bg-[#090909] px-4 py-2 text-[13px] font-semibold text-white outline-none"
                >
                  <option value="PUBLIC">Public</option>
                  <option value="PRIVATE">Private</option>
                </select>
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Billing</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[16px] font-semibold text-white">{currentTier} Plan</p>
                  <p className="mt-1 text-[13px] leading-6 text-[#8A8A8A]">
                    Upgrade when you want more signal, or manage your subscription if you are already paid.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setPricingOpen(true)}
                    className="rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1]"
                  >
                    {currentTier === "Trainer" ? "Upgrade Plan" : "Change Plan"}
                  </button>
                  {STRIPE_PORTAL_URL ? (
                    <Link
                      href={STRIPE_PORTAL_URL}
                      className="rounded-2xl border border-[#1E1E1E] px-4 py-2 text-[13px] font-semibold text-[#A3A3A3] transition hover:text-white"
                    >
                      Manage Billing
                    </Link>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Profile</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href="/profile"
                  className="rounded-2xl border border-[#1E1E1E] bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.1]"
                >
                  Edit Profile
                </Link>
                {publicProfileHref ? (
                  <Link
                    href={publicProfileHref}
                    className="rounded-2xl border border-[#1E1E1E] px-4 py-2 text-[13px] font-semibold text-[#A3A3A3] transition hover:text-white"
                  >
                    View Public Profile
                  </Link>
                ) : null}
              </div>
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Save</p>
                  <p className="mt-2 text-[13px] leading-6 text-[#8A8A8A]">
                    {loadingSettings ? "Loading your saved settings..." : "Apply the current notification and privacy changes."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={saveSettings}
                  disabled={loadingSettings || savingSettings}
                  className="rounded-2xl border border-[#1E1E1E] bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-white/[0.12] disabled:opacity-60"
                >
                  {savingSettings ? "Saving..." : "Save Settings"}
                </button>
              </div>
              {settingsError ? <p className="mt-3 text-[12px] text-[#FF8A80]">{settingsError}</p> : null}
              {settingsNotice ? <p className="mt-3 text-[12px] text-[#9CCBFF]">{settingsNotice}</p> : null}
            </section>

            <section className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#0B0B0B] px-5 py-5">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#6B6B6B]">Session</p>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[16px] font-semibold text-white">Sign out</p>
                  <p className="mt-1 text-[13px] text-[#8A8A8A]">End your session on this device.</p>
                </div>
                <SignOutButton>
                  <button
                    type="button"
                    className="rounded-2xl border border-[#3A1414] bg-[#2A1010] px-4 py-2 text-[13px] font-semibold text-[#FFB4B4] transition hover:bg-[#341313]"
                  >
                    Sign Out
                  </button>
                </SignOutButton>
              </div>
            </section>
          </div>
        </div>
      </div>

      <PricingModal open={pricingOpen} onClose={() => setPricingOpen(false)} />
    </>
  );
}

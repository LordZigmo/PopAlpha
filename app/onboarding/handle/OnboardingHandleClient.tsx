"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser, RedirectToSignIn } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { validateHandle, safeReturnTo } from "@/lib/handles";
import posthog from "posthog-js";

type AvailabilityState = "idle" | "checking" | "available" | "taken" | "error";

export default function OnboardingHandleClient() {
  const { user, isLoaded } = useUser();
  const searchParams = useSearchParams();

  const [raw, setRaw] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<AvailabilityState>("idle");
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Debounced availability check ──────────────────────────────────────

  const checkAvailability = useCallback(async (handle: string) => {
    setAvailability("checking");
    setServerError(null);
    try {
      const res = await fetch(
        `/api/handles/availability?handle=${encodeURIComponent(handle)}`,
      );
      const json = await res.json();
      if (!json.ok && json.reason) {
        setAvailability("error");
        setServerError(json.reason);
      } else if (json.available) {
        setAvailability("available");
      } else {
        setAvailability("taken");
      }
    } catch {
      setAvailability("error");
      setServerError("Could not check availability.");
    }
  }, []);

  const onInput = useCallback(
    (value: string) => {
      setRaw(value);
      setServerError(null);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      const result = validateHandle(value);
      if (!result.valid) {
        setClientError(value.trim().length > 0 ? result.reason : null);
        setAvailability("idle");
        return;
      }

      setClientError(null);
      debounceRef.current = setTimeout(() => {
        checkAvailability(value);
      }, 400);
    },
    [checkAvailability],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateHandle(raw);
    if (!result.valid) {
      setClientError(result.reason);
      return;
    }

    setSubmitting(true);
    setServerError(null);

    try {
      const res = await fetch("/api/onboarding/handle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: raw.trim() }),
      });

      const json = await res.json();

      if (!res.ok || !json.ok) {
        setServerError(json.error ?? "Something went wrong.");
        setSubmitting(false);
        return;
      }

      // Identify user and track handle claim
      if (user) {
        posthog.identify(user.id, {
          handle: json.handle,
          email: user.primaryEmailAddress?.emailAddress,
        });
      }
      posthog.capture("handle_claimed", {
        handle: json.handle,
      });

      // Success — redirect
      const returnTo = safeReturnTo(searchParams.get("return_to"));
      window.location.href = returnTo;
    } catch (err) {
      posthog.captureException(err);
      setServerError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
      </div>
    );
  }

  // ── Not signed in ─────────────────────────────────────────────────────

  if (!user) {
    return <RedirectToSignIn />;
  }

  // ── Form ──────────────────────────────────────────────────────────────

  const error = clientError || serverError;
  const canSubmit = !submitting && !clientError && availability === "available";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] px-4">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-[#F0F0F0]">Choose your handle</h1>
        <p className="mt-2 text-sm text-[#6B6B6B]">
          This is your unique identity on PopAlpha. You can&apos;t change it later.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
          <div>
            <div className="flex items-center rounded-xl border border-[#1E1E1E] bg-[#111] focus-within:border-[#3B3B3B] transition">
              <span className="pl-4 text-[#6B6B6B] select-none">@</span>
              <input
                type="text"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                value={raw}
                onChange={(e) => onInput(e.target.value)}
                placeholder="yourhandle"
                className="flex-1 bg-transparent px-2 py-3 text-sm text-[#F0F0F0] placeholder:text-[#3B3B3B] outline-none"
              />
              {availability === "checking" && (
                <div className="pr-4">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                </div>
              )}
            </div>

            {/* Feedback line */}
            <div className="mt-2 h-5 text-xs">
              {error && <span className="text-rose-400">{error}</span>}
              {!error && availability === "available" && (
                <span className="text-emerald-400">Available</span>
              )}
              {!error && availability === "taken" && (
                <span className="text-rose-400">That handle is already taken.</span>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-xl bg-[#F0F0F0] py-3 text-sm font-semibold text-[#0A0A0A] transition hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Claiming..." : "Claim handle"}
          </button>
        </form>
      </div>
    </div>
  );
}

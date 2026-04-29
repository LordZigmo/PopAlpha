"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSafeUser } from "@/lib/auth/use-safe-user";

type WaitlistFormProps = {
  variant?: "hero" | "final";
  id?: string;
  className?: string;
};

type WaitlistState = "idle" | "saving" | "success" | "error";

export default function WaitlistForm({ variant = "hero", id, className = "" }: WaitlistFormProps) {
  const { user } = useSafeUser();
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [formStartedAtMs, setFormStartedAtMs] = useState<number | null>(null);
  const [state, setState] = useState<WaitlistState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setFormStartedAtMs(Date.now());
  }, []);

  useEffect(() => {
    const prefill = user?.primaryEmailAddress?.emailAddress;
    if (prefill && !email) setEmail(prefill);
  }, [user?.primaryEmailAddress?.emailAddress, email]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "saving") return;

    setState("saving");
    setMessage(null);

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          tier: "Ace",
          website,
          formStartedAtMs,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Could not join the waitlist.");
      }

      setState("success");
      setMessage("You're on the waitlist. We'll email you when iPhone access opens up.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not join the waitlist.");
    }
  }

  const isHero = variant === "hero";
  const wrapperBase = isHero
    ? "w-full max-w-[520px]"
    : "mx-auto w-full max-w-[560px] rounded-[1.6rem] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(20,28,38,0.65),rgba(9,12,18,0.85))] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.45)] sm:p-8";

  return (
    <div id={id} className={`${wrapperBase} ${className}`.trim()}>
      <AnimatePresence mode="wait" initial={false}>
        {state === "success" ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="flex items-start gap-3 rounded-2xl border border-[#0E4233] bg-[#0B231C] px-4 py-4 text-[14px] text-[#A7F3D0]"
            role="status"
            aria-live="polite"
          >
            <svg className="mt-[2px] h-5 w-5 shrink-0 text-[#34D399]" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.414L8.5 12.086l6.793-6.793a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span>{message}</span>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onSubmit={handleSubmit}
            noValidate
          >
            {!isHero ? (
              <div className="mb-5 text-center">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7DD3FC]">Early access</p>
                <h3 className="mt-2 text-[24px] font-semibold tracking-[-0.02em] text-white">Get on the iPhone waitlist</h3>
                <p className="mt-2 text-[14px] leading-6 text-[#9FA4AE]">
                  We&rsquo;ll email you as soon as PopAlpha is available on the App Store.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <label htmlFor={`waitlist-email-${variant}`} className="sr-only">
                Email address
              </label>
              <input
                id={`waitlist-email-${variant}`}
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@email.com"
                className="w-full rounded-2xl border border-white/[0.08] bg-black/40 px-4 py-3 text-[15px] text-white outline-none placeholder:text-[#6B7280] transition focus:border-[#00B4D8] focus:bg-black/55"
                disabled={state === "saving"}
              />

              <div className="sr-only" aria-hidden="true">
                <label htmlFor={`waitlist-website-${variant}`}>Website</label>
                <input
                  id={`waitlist-website-${variant}`}
                  type="url"
                  autoComplete="off"
                  tabIndex={-1}
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={state === "saving"}
                className="inline-flex items-center justify-center whitespace-nowrap rounded-2xl bg-[#00B4D8] px-5 py-3 text-[14px] font-semibold text-[#060608] transition hover:bg-[#00C9F0] hover:shadow-[0_0_24px_rgba(0,180,216,0.35)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {state === "saving" ? "Joining…" : "Join Waitlist"}
              </button>
            </div>

            {state === "error" && message ? (
              <p className="mt-3 text-[13px] leading-5 text-rose-300" role="alert">
                {message}
              </p>
            ) : null}

            {isHero ? (
              <p className="mt-3 text-[12px] leading-5 text-[#7B8794]">
                Coming soon to App Store · iPhone. No spam — one email at launch.
              </p>
            ) : null}
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

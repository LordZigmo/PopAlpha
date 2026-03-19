import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation.js";
import { signInInternalAdminAction } from "@/app/internal/admin/actions";
import { clerkEnabled } from "@/lib/auth/clerk-enabled";
import {
  getInternalAdminSession,
  resolveCurrentInternalAdminAccess,
} from "@/lib/auth/internal-admin-session";
import { INTERNAL_ADMIN_DEFAULT_RETURN_TO, sanitizeInternalAdminReturnTo } from "@/lib/auth/internal-admin-session-core";

export const dynamic = "force-dynamic";

type SearchParams = {
  returnTo?: string;
  error?: string;
  notice?: string;
};

function friendlyMessage(input: SearchParams): { error: string | null; notice: string | null } {
  const error = input.error === "auth_required"
    ? "Sign in with an allowlisted PopAlpha operator account before opening internal admin access."
    : input.error === "misconfigured"
      ? "Internal admin allowlist configuration is missing. Add an allowlisted Clerk user id or email before using this surface."
      : input.error === "not_authorized"
        ? "Your PopAlpha account is authenticated, but it is not allowlisted for internal admin access."
        : null;

  const notice = input.notice === "signed_out" ? "Internal admin session cleared." : null;
  return { error, notice };
}

export default async function InternalAdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolved = await searchParams;
  const returnTo = sanitizeInternalAdminReturnTo(resolved.returnTo ?? INTERNAL_ADMIN_DEFAULT_RETURN_TO);
  const session = await getInternalAdminSession();
  if (session) {
    redirect(returnTo);
  }

  const message = friendlyMessage(resolved);
  const access = await resolveCurrentInternalAdminAccess();
  const clerkReturnHref = `/internal/admin/sign-in?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main className="app-shell min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center px-4 py-10 sm:px-6">
        <section className="w-full overflow-hidden rounded-[2rem] border border-[#1E1E1E] bg-[#0B0B0B] shadow-[0_30px_90px_rgba(0,0,0,0.35)]">
          <div className="grid gap-0 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="border-b border-[#1E1E1E] bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.14),_transparent_48%),linear-gradient(135deg,_#181818,_#090909)] p-8 sm:p-10 lg:border-b-0 lg:border-r">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B8B8B]">Internal Admin</p>
              <h1 className="mt-4 text-[34px] font-semibold tracking-[-0.05em] text-white">
                eBay deletion review
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-7 text-[#B1B1B1]">
                This surface is for manual review only. Verified eBay deletion receipts can be inspected,
                annotated, and escalated here, but no deletion or erasure happens from this tool.
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7E7E7E]">
                    Trust Boundary
                  </p>
                  <p className="mt-2 text-[13px] leading-6 text-[#D0D0D0]">
                    Server-rendered page, HttpOnly admin session cookie, and server-only calls into the existing
                    admin review JSON routes.
                  </p>
                </div>
                <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7E7E7E]">
                    What You Can Change
                  </p>
                  <p className="mt-2 text-[13px] leading-6 text-[#D0D0D0]">
                    Review state, review notes, and advisory candidate selection only. Every mutation remains
                    append-audited.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-8 sm:p-10">
              <div className="rounded-[1.5rem] border border-[#1E1E1E] bg-[#111111] p-6">
                <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#7E7E7E]">
                  Session Sign-In
                </p>
                <p className="mt-3 text-[14px] leading-6 text-[#A8A8A8]">
                  Internal admin access now uses trusted Clerk operator identity plus an explicit allowlist. This page
                  only opens a short-lived internal admin session for an already authenticated, allowlisted operator.
                </p>

                {message.notice ? (
                  <div className="mt-5 rounded-2xl border border-[#204A2F] bg-[#112316] px-4 py-3 text-[13px] text-[#C8F8D1]">
                    {message.notice}
                  </div>
                ) : null}
                {message.error ? (
                  <div className="mt-5 rounded-2xl border border-[#4A2121] bg-[#241111] px-4 py-3 text-[13px] text-[#FFCACA]">
                    {message.error}
                  </div>
                ) : null}

                {!clerkEnabled || access.kind === "misconfigured" ? (
                  <div className="mt-6 rounded-2xl border border-[#4A3720] bg-[#21170E] px-4 py-4 text-[13px] leading-6 text-[#FFE0B6]">
                    Internal admin access requires Clerk at runtime plus an explicit allowlist in
                    `INTERNAL_ADMIN_CLERK_USER_IDS` and/or `INTERNAL_ADMIN_EMAILS`.
                  </div>
                ) : access.kind === "unauthenticated" ? (
                  <div className="mt-6">
                    <p className="mb-4 text-[13px] leading-6 text-[#CFCFCF]">
                      Sign in with Clerk first. After sign-in, this page will re-check the internal admin allowlist
                      before issuing the short-lived admin session cookie.
                    </p>
                    <SignIn
                      fallbackRedirectUrl={clerkReturnHref}
                      appearance={{
                        elements: {
                          rootBox: "w-full",
                          card: "bg-transparent shadow-none border-none p-0",
                        },
                      }}
                    />
                  </div>
                ) : access.kind === "forbidden" ? (
                  <div className="mt-6 rounded-2xl border border-[#4A2121] bg-[#241111] px-4 py-4 text-[13px] leading-6 text-[#FFD0D0]">
                    <p className="font-semibold text-white">Access denied</p>
                    <p className="mt-2">
                      Signed in as {access.operator.displayName}
                      {access.operator.primaryEmail ? ` (${access.operator.primaryEmail})` : ""}
                      , but this account is not on the internal admin allowlist.
                    </p>
                    <p className="mt-2 text-[#FFBFBF]">Actor id: {access.operator.actorIdentifier}</p>
                  </div>
                ) : (
                  <form action={signInInternalAdminAction} className="mt-6 space-y-4">
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <div className="rounded-[1.5rem] border border-[#262626] bg-black px-4 py-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7E7E7E]">
                        Trusted Operator
                      </p>
                      <p className="mt-2 text-[15px] font-semibold text-white">{access.operator.displayName}</p>
                      <p className="mt-1 text-[13px] text-[#B9B9B9]">
                        {access.operator.primaryEmail ?? "No primary email available"}
                      </p>
                      <p className="mt-2 text-[12px] text-[#7E7E7E]">{access.operator.actorIdentifier}</p>
                    </div>
                    <button
                      type="submit"
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-white px-4 py-3 text-[14px] font-semibold text-black transition hover:bg-[#E7E7E7]"
                    >
                      Open Internal Review
                    </button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

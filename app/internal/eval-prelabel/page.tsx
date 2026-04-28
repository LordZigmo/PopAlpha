/**
 * /internal/eval-prelabel
 *
 * VLM-assisted bulk labeling page for the scanner eval corpus.
 * Operator drops a folder of card photos; we run each through
 * Gemini Flash to pre-extract printed fields, resolve those to
 * canonical_slug candidates, and present a confirm/edit queue.
 * Confirmed entries land in scan_eval_images via the existing
 * promote endpoint.
 *
 * Auth: internal-admin session (Clerk allowlist + cookie).
 *
 * Lives at /internal/eval-prelabel (a sibling to /internal/admin)
 * rather than under it, on purpose. The /internal/admin tree is
 * locked by check-internal-admin-pages.mjs to server-only rendering
 * and a whitelisted fetch surface — appropriate for the eBay
 * deletion review's strict trust profile, but blocks the drag/drop
 * + queue UI this page needs. Same `requireInternalAdminSession`
 * auth gate is reused so the ACL is identical.
 */

import { redirect } from "next/navigation.js";
import { requireInternalAdminSession } from "@/lib/auth/internal-admin-session";
import { signOutInternalAdminAction } from "@/app/internal/admin/actions";
import EvalPrelabelClient from "./EvalPrelabelClient";

export const dynamic = "force-dynamic";

export default async function EvalPrelabelPage() {
  const session = await requireInternalAdminSession("/internal/eval-prelabel");
  if (!session) {
    // requireInternalAdminSession either returns the session or throws/redirects.
    // Defensive guard for future shape changes.
    redirect("/internal/admin/sign-in");
  }

  return (
    <main className="app-shell min-h-screen">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <section className="overflow-hidden rounded-[2rem] border border-[#1E1E1E] bg-[#0C0C0C]">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1E1E1E] px-6 py-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6B6B6B]">
                Internal Admin
              </p>
              <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">
                Eval-corpus pre-labeling
              </h1>
              <p className="mt-2 max-w-3xl text-[14px] leading-6 text-[#A3A3A3]">
                Drop card photos. Gemini reads the printed name, set, and
                collector number; we propose canonical_slug candidates;
                you confirm or correct. Confirmed entries land in
                scan_eval_images for fine-tuning.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-3 text-right">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#7A7A7A]">
                  Operator
                </p>
                <p className="mt-1 text-[13px] font-semibold text-white">{session.displayName}</p>
                <p className="mt-1 text-[11px] text-[#7A7A7A]">
                  {session.primaryEmail ?? session.clerkUserId}
                </p>
              </div>

              <form action={signOutInternalAdminAction}>
                <button
                  type="submit"
                  className="inline-flex items-center rounded-2xl border border-[#3A2020] bg-[#201010] px-4 py-3 text-[13px] font-semibold text-[#FFD3D3] transition hover:bg-[#2A1515]"
                >
                  Sign Out
                </button>
              </form>
            </div>
          </div>

          <div className="px-6 py-6">
            <EvalPrelabelClient />
          </div>
        </section>
      </div>
    </main>
  );
}

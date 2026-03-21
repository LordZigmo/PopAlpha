import type { ReactNode } from "react";
import Link from "next/link";
import { requireInternalAdminSession } from "@/lib/auth/internal-admin-session";
import { signOutInternalAdminAction } from "@/app/internal/admin/actions";

export const dynamic = "force-dynamic";

export default async function InternalAdminProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireInternalAdminSession("/internal/admin/ebay-deletion-tasks");

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
                eBay deletion manual review
              </h1>
              <p className="mt-2 max-w-3xl text-[14px] leading-6 text-[#A3A3A3]">
                Verified receipts, advisory matches, and append-only audit events only. No deletion or erasure runs
                from this interface.
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
                <p className="mt-1 text-[11px] text-[#7A7A7A]">{session.actorIdentifier}</p>
              </div>

              <Link
                href="/internal/admin/ebay-deletion-tasks"
                className="inline-flex items-center rounded-2xl border border-[#1E1E1E] bg-white/[0.04] px-4 py-3 text-[13px] font-semibold text-white transition hover:bg-white/[0.08]"
              >
                Review Queue
              </Link>

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

          <div className="px-6 py-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

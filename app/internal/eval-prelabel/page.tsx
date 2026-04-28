/**
 * /internal/eval-prelabel
 *
 * VLM-assisted bulk labeling for the scanner eval corpus.
 * Auth: internal-admin session — same gate as the eBay deletion
 * review. Lives outside /internal/admin so the strict server-only
 * guard there doesn't block the client-side drag/drop UI we need.
 */

import { redirect } from "next/navigation.js";
import { requireInternalAdminSession } from "@/lib/auth/internal-admin-session";
import { signOutInternalAdminAction } from "@/app/internal/admin/actions";
import EvalPrelabelClient from "./EvalPrelabelClient";

export const dynamic = "force-dynamic";

export default async function EvalPrelabelPage() {
  const session = await requireInternalAdminSession("/internal/eval-prelabel");
  if (!session) redirect("/internal/admin/sign-in");

  return (
    <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "#fff", padding: 24 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Eval pre-labeling</h1>
        <form action={signOutInternalAdminAction}>
          <button
            type="submit"
            style={{
              fontSize: 12,
              color: "#aaa",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Sign out ({session.displayName})
          </button>
        </form>
      </header>
      <EvalPrelabelClient />
    </main>
  );
}

import { NextResponse } from "next/server";
import { dbPublic } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, string> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    node: process.version,
  };

  // Test Supabase connectivity
  try {
    const t0 = Date.now();
    const db = dbPublic();
    const { data, error } = await db
      .from("canonical_cards")
      .select("slug")
      .limit(1);
    const ms = Date.now() - t0;
    checks.supabase = error ? `error: ${error.message}` : `ok (${ms}ms, rows=${data?.length ?? 0})`;
  } catch (err) {
    checks.supabase = `init_error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return NextResponse.json(checks);
}

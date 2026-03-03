import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { dbAdmin } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(_);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false, error: "Missing sale id." }, { status: 400 });

  try {
    const supabase = dbAdmin();

    // Verify ownership before deleting
    const { data: row, error: fetchError } = await supabase
      .from("private_sales")
      .select("owner_id")
      .eq("id", id)
      .maybeSingle();

    if (fetchError) return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
    if (!row) return NextResponse.json({ ok: false, error: "Sale not found." }, { status: 404 });
    if (row.owner_id !== userId) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { error } = await supabase.from("private_sales").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

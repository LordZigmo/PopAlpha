import { NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

type PrivateSaleRow = {
  id: string;
  cert: string;
  price: number;
  currency: string;
  sold_at: string;
  fees: number | null;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
};

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function GET(req: Request) {
  const cert = new URL(req.url).searchParams.get("cert")?.trim() ?? "";
  if (!cert) {
    return NextResponse.json({ ok: false, error: "Missing cert query param." }, { status: 400 });
  }

  try {
    const supabase = getServerSupabaseClient();
    const { data, error } = await supabase
      .from("private_sales")
      .select("id, cert, price, currency, sold_at, fees, payment_method, notes, created_at")
      .eq("cert", cert)
      .order("sold_at", { ascending: false })
      .returns<PrivateSaleRow[]>();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, sales: data ?? [] });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let payload: Record<string, unknown>;

  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const cert = typeof payload.cert === "string" ? payload.cert.trim() : "";
  const soldAt = typeof payload.sold_at === "string" ? payload.sold_at.trim() : "";
  const currency = typeof payload.currency === "string" && payload.currency.trim() ? payload.currency.trim() : "USD";
  const paymentMethod = typeof payload.payment_method === "string" && payload.payment_method.trim() ? payload.payment_method.trim() : null;
  const notes = typeof payload.notes === "string" && payload.notes.trim() ? payload.notes.trim() : null;
  const price = parseNumber(payload.price);
  const fees = payload.fees === null || payload.fees === undefined || payload.fees === "" ? null : parseNumber(payload.fees);

  if (!cert) {
    return NextResponse.json({ ok: false, error: "cert is required." }, { status: 400 });
  }

  if (price === null || price <= 0) {
    return NextResponse.json({ ok: false, error: "price must be a positive number." }, { status: 400 });
  }

  if (!soldAt || Number.isNaN(new Date(soldAt).getTime())) {
    return NextResponse.json({ ok: false, error: "sold_at must be a valid ISO date." }, { status: 400 });
  }

  if (fees !== null && fees < 0) {
    return NextResponse.json({ ok: false, error: "fees must be non-negative when provided." }, { status: 400 });
  }

  try {
    const supabase = getServerSupabaseClient();

    const { data, error } = await supabase
      .from("private_sales")
      .insert({
        cert,
        price,
        currency,
        sold_at: soldAt,
        fees,
        payment_method: paymentMethod,
        notes,
      })
      .select("id, cert, price, currency, sold_at, fees, payment_method, notes, created_at")
      .single<PrivateSaleRow>();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, sale: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

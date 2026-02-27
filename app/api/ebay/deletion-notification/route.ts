import { createHash } from "crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const challengeCode = u.searchParams.get("challenge_code")?.trim() ?? "";
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN?.trim() ?? "";

  if (!challengeCode) {
    return NextResponse.json({ ok: false, error: "Missing challenge_code query param." }, { status: 400 });
  }

  if (!verificationToken) {
    return NextResponse.json({ ok: false, error: "Missing EBAY_VERIFICATION_TOKEN." }, { status: 400 });
  }

  const endpoint = `${u.origin}${u.pathname}`;
  const challengeResponse = createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest("hex");

  return NextResponse.json({ challengeResponse });
}

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ received: false, error: "Invalid JSON body." }, { status: 400 });
  }

  console.log("[ebay.deletion-notification] received", payload);
  return NextResponse.json({ received: true });
}

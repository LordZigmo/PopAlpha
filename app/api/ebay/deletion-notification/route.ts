import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db/admin";
import {
  buildEbayDeletionReceiptRow,
  handleEbayDeletionNotification,
} from "@/lib/ebay/deletion-notification";

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
  return handleEbayDeletionNotification(req, {
    persistReceipt: async ({ payload, verification }) => {
      const { error } = await dbAdmin()
        .from("ebay_deletion_notification_receipts")
        .insert(buildEbayDeletionReceiptRow({ payload, verification }));

      if (!error) {
        return { stored: true };
      }

      if (error.code === "23505") {
        return { stored: false };
      }

      throw error;
    },
  });
}

import {
  handleAdminEbayDeletionTaskDetail,
  handleAdminEbayDeletionTaskPatch,
} from "@/lib/ebay/deletion-review-routes";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdminEbayDeletionTaskDetail(req, { params });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleAdminEbayDeletionTaskPatch(req, { params });
}

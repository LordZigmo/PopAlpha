import { handleAdminEbayDeletionTaskList } from "@/lib/ebay/deletion-review-routes";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleAdminEbayDeletionTaskList(req);
}

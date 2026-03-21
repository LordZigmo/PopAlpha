import { redirect } from "next/navigation.js";

export const dynamic = "force-dynamic";

export default function InternalAdminRootPage() {
  redirect("/internal/admin/ebay-deletion-tasks");
}

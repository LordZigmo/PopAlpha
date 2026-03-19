import assert from "node:assert/strict";
import {
  EBAY_DELETION_REVIEW_ADMIN_API_BASE,
  assertAllowedEbayDeletionReviewAdminApiPath,
  buildEbayDeletionReviewAdminApiPath,
  buildInternalAdminRouteHeaders,
} from "../lib/ebay/deletion-review-admin-api-core.ts";

export function runEbayDeletionReviewAdminApiTests() {
  const listPath = buildEbayDeletionReviewAdminApiPath({
    reviewState: "pending_review",
    notificationId: "notif-123",
    limit: 25,
  });
  assert.equal(
    listPath,
    `${EBAY_DELETION_REVIEW_ADMIN_API_BASE}?reviewState=pending_review&notificationId=notif-123&limit=25`,
  );

  const detailPath = buildEbayDeletionReviewAdminApiPath({ taskId: "task-1" });
  assert.equal(detailPath, `${EBAY_DELETION_REVIEW_ADMIN_API_BASE}/task-1`);
  assert.equal(assertAllowedEbayDeletionReviewAdminApiPath(detailPath), detailPath);

  assert.throws(
    () => buildEbayDeletionReviewAdminApiPath({ taskId: "task/one" }),
    /Invalid task id/,
  );
  assert.throws(
    () => assertAllowedEbayDeletionReviewAdminApiPath("/api/admin/import/pokemontcg"),
    /must start with/,
  );
  assert.throws(
    () => assertAllowedEbayDeletionReviewAdminApiPath(`${EBAY_DELETION_REVIEW_ADMIN_API_BASE}/task-1/audit`),
    /single task detail route/,
  );

  const requestHeaders = buildInternalAdminRouteHeaders(
    { cookieHeader: "foo=bar; popalpha_internal_admin=signed" },
  );
  assert.equal(requestHeaders.get("cookie"), "foo=bar; popalpha_internal_admin=signed");
  assert.equal(requestHeaders.get("accept"), "application/json");
  assert.equal(requestHeaders.get("x-admin-secret"), null);
  assert.equal(requestHeaders.get("x-operator-id"), null);
}

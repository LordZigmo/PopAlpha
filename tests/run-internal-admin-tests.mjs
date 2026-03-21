import { runDebugRouteTrustTests } from "./debug-route-trust.test.mjs";
import { runInternalAdminSessionTests } from "./internal-admin-session.test.mjs";
import { runInternalRouteTrustTests } from "./internal-route-trust.test.mjs";
import { runEbayDeletionReviewAdminApiTests } from "./ebay-deletion-review-admin-api.test.mjs";

runDebugRouteTrustTests();
runInternalAdminSessionTests();
runInternalRouteTrustTests();
runEbayDeletionReviewAdminApiTests();

console.log("internal admin tests passed");

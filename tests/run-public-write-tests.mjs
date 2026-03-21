import { runPublicWriteUtilsTests } from "./public-write-utils.test.mjs";
import { runEbayDeletionNotificationTests } from "./ebay-deletion-notification.test.mjs";
import { runEbayDeletionReceiptProcessorTests } from "./ebay-deletion-receipt-processor.test.mjs";
import { runEbayDeletionReviewTests } from "./ebay-deletion-review.test.mjs";
import { runWaitlistGuardrailTests } from "./waitlist-guardrails.test.mjs";

runPublicWriteUtilsTests();
runWaitlistGuardrailTests();
await runEbayDeletionNotificationTests();
await runEbayDeletionReceiptProcessorTests();
await runEbayDeletionReviewTests();

console.log("public write tests passed");

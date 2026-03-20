import { formatLinkedDbBootstrap, getLinkedDbStatus } from "./lib/linked-db.mjs";

const status = getLinkedDbStatus();

if (!status.ready) {
  console.error("linked db prerequisite check FAILED:");
  console.error(formatLinkedDbBootstrap(status));
  process.exit(1);
}

console.log("linked db prerequisite check passed");
console.log(formatLinkedDbBootstrap(status, { includeSummary: false }));

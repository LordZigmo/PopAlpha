import { runFxRateLookupTests } from "./fx-rate-lookup.test";

async function main() {
  await runFxRateLookupTests();
  console.log("fx tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

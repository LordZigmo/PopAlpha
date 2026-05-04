import { runCardProfileFallbackTests } from "./card-profile-fallback.test";

async function main() {
  await runCardProfileFallbackTests();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

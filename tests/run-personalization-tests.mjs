import { runScoringTests } from "./personalization/scoring.test.mjs";
import { runSummaryTests } from "./personalization/summary.test.mjs";
import { runSchemaTests } from "./personalization/schema.test.mjs";
import { runExplanationTemplateTests } from "./personalization/explanation-template.test.mjs";
import { runCollectorInsightTests } from "./personalization/collector-insight.test.mjs";
import { runActorMappingTests } from "./personalization/actor-mapping.test.mjs";
import { runLowConfidenceTests } from "./personalization/low-confidence.test.mjs";
import { runTeaserContractTests } from "./personalization/teaser-contract.test.mjs";

await runSchemaTests();
await runActorMappingTests();
await runScoringTests();
await runSummaryTests();
await runExplanationTemplateTests();
await runCollectorInsightTests();
await runLowConfidenceTests();
await runTeaserContractTests();

console.log("personalization tests passed");

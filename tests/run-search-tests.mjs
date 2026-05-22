import { runSearchNormalizeTests } from "./search-normalize.test.mjs";
import { runSearchCardsTests } from "./search-cards.test.mjs";
import { runSearchHighlightTests } from "./search-highlight.test.mjs";
import { runSearchBackfillPaginationTests } from "./search-backfill-pagination.test.mjs";
import { runSearchSortTests } from "./search-sort.test.mjs";
import { runVariantRefTests } from "./variant-ref.test.mjs";
import { runSetSummaryPipelineTests } from "./set-summary-pipeline.test.mjs";
import { runCardDisplayTests } from "./card-display.test.mjs";

runCardDisplayTests();
runSearchNormalizeTests();
runSearchCardsTests();
runSearchHighlightTests();
await runSearchBackfillPaginationTests();
runSearchSortTests();
runVariantRefTests();
runSetSummaryPipelineTests();

console.log("search tests passed");

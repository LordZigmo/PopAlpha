import { runSearchNormalizeTests } from "./search-normalize.test.mjs";
import { runSearchCardsTests } from "./search-cards.test.mjs";
import { runSearchHighlightTests } from "./search-highlight.test.mjs";
import { runSearchBackfillPaginationTests } from "./search-backfill-pagination.test.mjs";
import { runSearchSortTests } from "./search-sort.test.mjs";
import { runVariantRefTests } from "./variant-ref.test.mjs";
import { runJustTcgTrackedSelectionTests } from "./justtcg-tracked-selection.test.mjs";
import { runJustTcgNormalizationTests } from "./justtcg-normalization.test.mjs";

runSearchNormalizeTests();
runSearchCardsTests();
runSearchHighlightTests();
await runSearchBackfillPaginationTests();
runSearchSortTests();
runVariantRefTests();
runJustTcgTrackedSelectionTests();
runJustTcgNormalizationTests();

console.log("search tests passed");

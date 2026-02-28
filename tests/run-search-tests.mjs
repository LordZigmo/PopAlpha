import { runSearchNormalizeTests } from "./search-normalize.test.mjs";
import { runSearchCardsTests } from "./search-cards.test.mjs";
import { runSearchHighlightTests } from "./search-highlight.test.mjs";

runSearchNormalizeTests();
runSearchCardsTests();
runSearchHighlightTests();

console.log("search tests passed");

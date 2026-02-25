# PopAlpha
PopAlpha is a Next.js-based arbitrage analytics engine for trading cards.

Features:

Structured card + grade modeling

Pluggable PriceProvider interface

Prebaked static dataset for development

Net spread, liquidity, and confidence scoring

Edge ranking algorithm

The architecture intentionally separates:

Data ingestion

Pricing normalization

Scoring logic

UI presentation

This allows seamless migration from static JSON data to live API integrations (TCGplayer, eBay, grading data) without refactoring core logic.

PopAlpha is built as a foundation for scalable collectible market intelligence.

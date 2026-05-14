/**
 * JP Pokémon TCG glossary — operator + matcher reference.
 *
 * What this is: hand-curated lookup for the ~150 terms that appear in
 * 95% of Japanese Pokemon card listings on Yahoo! Auctions, Mercari,
 * and Snkrdunk. Covers four categories:
 *
 *   1. ERA + EDITION markers     (旧裏, 新裏, 1ED, 第1弾)
 *   2. CONDITION + GRADING       (美品, 中古, PSA10, 鑑定品)
 *   3. RARITY + FINISH symbols   (UR, SAR, レアホロ, 闪卡)
 *   4. POKEMON + SET name pairs  (リザードン↔Charizard, 拡張パック↔Base Set)
 *
 * What this is NOT: an exhaustive translation library. We deliberately
 * cover only terms that appear repeatedly in marketplace listings.
 * Anything ambiguous or rare gets routed to the LLM matcher (Day 2 PM).
 *
 * Why a flat .mjs file rather than a JSON or DB table:
 *   - The matcher loads it once at startup; ~150 entries is tiny.
 *   - Hand-edits with code review > a CRUD admin page for a static list.
 *   - The CLI gloss tool (scripts/jp-gloss.mjs) imports it directly.
 *   - Future: a translation contributor can PR new entries without
 *     touching the DB.
 */

// =============================================================================
// 1. ERA + EDITION markers
// =============================================================================
// These are the most operationally useful terms — they distinguish
// vintage from modern at a glance, and Japanese sellers rely on them
// heavily. "旧裏" alone tells you a card is pre-2003 era.
export const ERA_MARKERS = {
  "旧裏": { en: "old-back", note: "Pre-2003 vintage cards (back-of-card design A)" },
  "旧裏面": { en: "old-back (formal)", note: "Same as 旧裏; more formal phrasing" },
  "新裏": { en: "new-back", note: "Post-2003 modern cards (back-of-card design B)" },
  "新裏面": { en: "new-back (formal)", note: "Same as 新裏" },
  "当時物": { en: "vintage / period-original", note: "Confirms card is from its original print run, not a reprint" },
  "復刻": { en: "reprint / reissue", note: "WARNING: this is a modern reprint, not a vintage original" },
  "再録": { en: "re-included", note: "Card was reprinted in a later set" },
};

export const EDITION_MARKERS = {
  "1ED": { en: "1st Edition", note: "The Japanese 1st Edition stamp on a card" },
  "1st Edition": { en: "1st Edition", note: "English-language stamp, also seen on JP listings" },
  "第1弾": { en: "1st expansion", note: "Base Set in Japanese release nomenclature" },
  "第2弾": { en: "2nd expansion", note: "Jungle in Japanese release" },
  "第3弾": { en: "3rd expansion", note: "Fossil in Japanese release" },
  "第4弾": { en: "4th expansion", note: "Team Rocket in Japanese release" },
  "第5弾": { en: "5th expansion", note: "Gym Heroes in Japanese release" },
  "初版": { en: "first printing", note: "First print run, not a reprint" },
  "未開封": { en: "sealed/unopened", note: "Sealed product (booster pack, deck, box) — typically NOT a single card" },
  "開封済": { en: "opened", note: "Booster opened; usually paired with single-card listings" },
  "プロモ": { en: "promo", note: "Promotional card; check sub-set" },
  "PROMO": { en: "promo", note: "Same as プロモ" },
  "限定": { en: "limited", note: "Limited release / event-exclusive" },
  "イベント限定": { en: "event-limited", note: "Distributed at a specific event only" },
};

// =============================================================================
// 2. CONDITION + GRADING terms
// =============================================================================
export const CONDITION_TERMS = {
  "美品": { en: "near mint", note: "Excellent condition; minor wear at most" },
  "極美品": { en: "mint", note: "Pristine condition; near-perfect" },
  "良品": { en: "very good", note: "Light wear; clearly used but still nice" },
  "中古": { en: "used", note: "Generic 'used' marker; condition varies" },
  "並品": { en: "average condition", note: "Visible wear; fair condition" },
  "傷あり": { en: "scratched/damaged", note: "Has visible damage — verify with images" },
  "キズあり": { en: "scratched (katakana)", note: "Same as 傷あり" },
  "スレあり": { en: "edge wear", note: "Edge wear / surface scuffing" },
  "白かけ": { en: "white edge wear", note: "White showing through edge color — vintage condition issue" },
  "状態A": { en: "condition A (excellent)", note: "Seller-defined A grade — top condition for that seller" },
  "状態B": { en: "condition B (good)", note: "Seller-defined B grade — minor wear" },
  "状態C": { en: "condition C (fair)", note: "Seller-defined C grade — visible wear" },
  "未使用": { en: "unused", note: "Never played/handled; usually pulled-fresh" },
  "新品": { en: "brand new", note: "New / never played" },
  "観賞用": { en: "display only", note: "Display piece — implies it's been kept pristine" },
};

export const GRADING_TERMS = {
  "鑑定品": { en: "graded/authenticated", note: "Has been third-party graded" },
  "鑑定済": { en: "graded (already)", note: "Same as 鑑定品" },
  "PSA10": { en: "PSA 10 (Gem Mint)", note: "Top PSA grade" },
  "PSA9": { en: "PSA 9 (Mint)", note: "Second-highest PSA grade" },
  "PSA8": { en: "PSA 8 (NM-Mint)", note: "Near mint" },
  "PSA7": { en: "PSA 7 (NM)", note: "Near mint with light wear" },
  "PSA6": { en: "PSA 6 (EX-NM)", note: "Excellent to near mint" },
  "BGS10": { en: "BGS 10 (Pristine)", note: "Top Beckett grade" },
  "BGS9.5": { en: "BGS 9.5 (Gem Mint)", note: "Beckett gem mint" },
  "BGS9": { en: "BGS 9 (Mint)", note: "Beckett mint" },
  "CGC10": { en: "CGC 10 (Pristine)", note: "Top CGC grade" },
  "CGC9.5": { en: "CGC 9.5 (Gem Mint)", note: "CGC gem mint" },
  "CGC9": { en: "CGC 9 (Mint)", note: "CGC mint" },
  "ARS": { en: "ARS Grading", note: "Asian-region grading service; common on JP listings" },
  "TAG": { en: "TAG Grading", note: "Modern grading service; AI-assisted" },
};

// =============================================================================
// 3. RARITY + FINISH symbols
// =============================================================================
// These appear as title tokens. They affect the canonical match because
// HOLO vs ALT_HOLO vs RAW are distinct printings in our schema.
export const RARITY_TERMS = {
  "レアホロ": { en: "Rare Holo", note: "Standard holographic rare" },
  "ホロ": { en: "Holo", note: "Holographic finish (any rarity)" },
  "ホロ仕様": { en: "Holo treatment", note: "Has holographic foil applied" },
  "キラ": { en: "shiny / foil", note: "Generic foil treatment" },
  "ノンホロ": { en: "non-holo", note: "Standard non-foil card" },
  "ミラー": { en: "mirror / reverse holo", note: "Reverse-holo printing" },
  "リバースホロ": { en: "reverse holo", note: "Same as ミラー" },
  "UR": { en: "UR (Ultra Rare)", note: "Highest standard rarity in modern era" },
  "SR": { en: "SR (Super Rare)", note: "Full-art card, modern era" },
  "SAR": { en: "SAR (Special Art Rare)", note: "Special art version, modern era" },
  "AR": { en: "AR (Art Rare)", note: "Art rare, modern era" },
  "MUR": { en: "MUR (Mega Ultra Rare)", note: "Mega Ultra Rare, modern" },
  "RR": { en: "RR (Double Rare)", note: "Double Rare, modern" },
  "RRR": { en: "RRR (Triple Rare)", note: "Triple Rare, modern (often full-art)" },
  "U": { en: "U (Uncommon)", note: "Standard uncommon rarity" },
  "C": { en: "C (Common)", note: "Standard common rarity" },
  "PR": { en: "PR (Promo)", note: "Promotional card" },
  "レアリティマークあり": { en: "with rarity symbol", note: "Print variant — has the small rarity symbol on card face" },
  "レアリティマークなし": { en: "no rarity symbol", note: "Print variant — early print runs lack the symbol" },
  "光るポケモン": { en: "Shining Pokemon", note: "Neo-era Shining variant; very valuable" },
  "わるい": { en: "Dark", note: "Team Rocket era 'Dark' Pokemon prefix (e.g., わるいリザードン = Dark Charizard)" },
  "かえん": { en: "Flame (attack name)", note: "Charizard's 'Flamethrower' attack — distinguishes Stage 2 Charizard from Stage 1" },
  "δ": { en: "delta species", note: "EX-era delta species variant" },
};

// =============================================================================
// 4. POKEMON name pairs (subset — most-traded vintage + modern)
// =============================================================================
// This is a starter list; the canonical_cards.canonical_name_native column
// (after backfill) is the authoritative source. This static map is for:
//   - The CLI gloss tool when no DB is available
//   - Fallback when Scrydex returned no native name for a card
//   - Operator-facing display in listings where DB lookup would be slow
export const POKEMON_NAMES = {
  "リザードン": "Charizard",
  "ピカチュウ": "Pikachu",
  "フシギダネ": "Bulbasaur",
  "フシギソウ": "Ivysaur",
  "フシギバナ": "Venusaur",
  "ヒトカゲ": "Charmander",
  "リザード": "Charmeleon",
  "ゼニガメ": "Squirtle",
  "カメール": "Wartortle",
  "カメックス": "Blastoise",
  "ミュウ": "Mew",
  "ミュウツー": "Mewtwo",
  "ライチュウ": "Raichu",
  "イーブイ": "Eevee",
  "サンダース": "Jolteon",
  "シャワーズ": "Vaporeon",
  "ブースター": "Flareon",
  "エーフィ": "Espeon",
  "ブラッキー": "Umbreon",
  "リーフィア": "Leafeon",
  "グレイシア": "Glaceon",
  "ニンフィア": "Sylveon",
  "カイリュー": "Dragonite",
  "ゲンガー": "Gengar",
  "ナッシー": "Exeggutor",
  "ゴース": "Gastly",
  "ゴースト": "Haunter",
  "ヤドン": "Slowpoke",
  "ヤドラン": "Slowbro",
  "コダック": "Psyduck",
  "ゴルダック": "Golduck",
  "ニャース": "Meowth",
  "ペルシアン": "Persian",
  "ピッピ": "Clefairy",
  "プリン": "Jigglypuff",
  "ラッキー": "Chansey",
  "ガルーラ": "Kangaskhan",
  "ケンタロス": "Tauros",
  "ベイビィ": "(generic 'baby' Pokemon prefix)",
  "ホウオウ": "Ho-Oh",
  "ルギア": "Lugia",
  "セレビィ": "Celebi",
  "ライコウ": "Raikou",
  "エンテイ": "Entei",
  "スイクン": "Suicune",
  // Modern era — frequently traded
  "ルカリオ": "Lucario",
  "ガブリアス": "Garchomp",
  "シャンデラ": "Chandelure",
  "ゾロアーク": "Zoroark",
  "ジラーチ": "Jirachi",
  "ディアルガ": "Dialga",
  "パルキア": "Palkia",
  "アルセウス": "Arceus",
  "ゼクロム": "Zekrom",
  "レシラム": "Reshiram",
  "キュレム": "Kyurem",
  "ゲンシグラードン": "Primal Groudon",
  "ゲンシカイオーガ": "Primal Kyogre",
  "メガ": "Mega (prefix)",
  "ニンフィア": "Sylveon",
  "ガラル": "Galarian (prefix)",
  "ヒスイ": "Hisuian (prefix)",
  "アローラ": "Alolan (prefix)",
};

// Gym Leader / Trainer name prefixes used in vintage Gym Heroes / Gym
// Challenge sets. These appear as possessive prefixes on Pokemon names —
// e.g., "カツラのリザードン" = "Blaine's Charizard". Critical for matching
// vintage Gym set cards because the prefix changes the canonical_slug.
export const TRAINER_PREFIXES = {
  "エリカの": "Erika's",
  "カスミの": "Misty's",
  "タケシの": "Brock's",
  "マチスの": "Lt. Surge's",
  "カツラの": "Blaine's",
  "キョウの": "Koga's",
  "サカキの": "Giovanni's",
  "ナツメの": "Sabrina's",
  "ロケット団の": "Team Rocket's",
  // Region/origin prefixes that appear in modern sets too
  "ガラルの": "Galarian",
  "ヒスイの": "Hisuian",
  "アローラの": "Alolan",
  "パルデアの": "Paldean",
};

// =============================================================================
// 5. SET name pairs (starter — backfill will populate the rest into DB)
// =============================================================================
export const SET_NAMES = {
  "拡張パック": "Expansion Pack (= Base Set)",
  "ポケモンジャングル": "Pokemon Jungle",
  "化石の秘密": "Mystery of the Fossils (= Fossil)",
  "ロケット団": "Team Rocket",
  "リーダーズスタジアム": "Leaders Stadium (= Gym Heroes)",
  "闇からの挑戦": "Challenge from the Darkness (= Gym Challenge)",
  "金、銀、新世界へ": "Gold, Silver, to a New World (= Neo Genesis)",
  "遺跡をこえて": "Crossing the Ruins (= Neo Discovery)",
  "めざめる伝説": "Awakening Legends (= Neo Revelation)",
  "闇、そして光へ": "Darkness, and to the Light (= Neo Destiny)",
  "プレミアムファイル": "Premium File",
  "拡張シート": "Expansion Sheet",
  "ベース": "Base",
  "時空の創造": "Creation of Time and Space (= Diamond/Pearl base)",
  "Topsun": "Topsun (1995 promo)",
  "25周年": "25th Anniversary",
  "25th ANNIVERSARY COLLECTION": "25th Anniversary Collection",
  "プロモカード": "Promo Card",
  "おたんじょうび": "Birthday (promo prefix)",
};

// =============================================================================
// 6. LISTING PHRASES + flags
// =============================================================================
// Common one-off phrases and seller-shorthand that don't fit the categories
// above but appear repeatedly in titles. Surface these in the gloss output
// so the operator can read the listing fully.
export const LISTING_PHRASES = {
  "送料無料": { en: "free shipping", note: "" },
  "同梱可": { en: "combined-shipping OK", note: "" },
  "同梱歓迎": { en: "combined-shipping welcome", note: "" },
  "即決": { en: "buy-it-now / fixed-price", note: "Auction can be ended early at this price" },
  "即決価格": { en: "BIN price", note: "Buy-it-now price" },
  "値下げ": { en: "price reduced", note: "Seller has lowered the price" },
  "ノークレームノーリターン": { en: "no claims / no returns", note: "Standard JP marketplace disclaimer" },
  "NCNR": { en: "no claims / no returns (acronym)", note: "Same as ノークレームノーリターン" },
  "中古品": { en: "used item", note: "Generic used-product marker" },
  "個人保管": { en: "private storage", note: "Stored by individual collector — not a shop" },
  "希少": { en: "rare", note: "Seller's claim of rarity" },
  "絶版": { en: "out of print", note: "No longer printed; vintage signal" },
  "高騰中": { en: "price rising", note: "Seller's claim that the card is appreciating" },
  "美麗": { en: "beautiful", note: "Seller's condition adjective" },
  "ポケモンカード": { en: "Pokemon Card", note: "Generic 'Pokemon card' label" },
  "ポケカ": { en: "PokeCa (Pokemon TCG slang)", note: "Common abbreviation" },
  "ポケモンカードゲーム": { en: "Pokemon Trading Card Game", note: "Full official name" },
  "レア": { en: "rare", note: "Generic rare marker; not a specific rarity symbol" },
  "シングルカード": { en: "single card", note: "Single-card listing (not a lot/bulk)" },
  "オリパ": { en: "Oripa (random pull pack)", note: "Mystery-pull packs assembled by sellers — NOT a real card" },
  "セット": { en: "set/lot", note: "WARNING: multi-card lot, not a single card" },
  "まとめ": { en: "bulk/lot", note: "WARNING: bulk listing — not a single card" },
  "まとめ売り": { en: "bulk sale", note: "WARNING: same as まとめ" },
  "セット販売": { en: "set sale", note: "WARNING: multi-card listing" },
  "デッキ": { en: "deck", note: "WARNING: pre-built deck — multiple cards" },
  "ボックス": { en: "box", note: "WARNING: booster box — sealed product" },
  "BOX": { en: "BOX", note: "Same as ボックス" },
  "未開封BOX": { en: "sealed BOX", note: "Sealed booster box" },
  "ブースター": { en: "booster", note: "Booster pack" },
  "プレイマット": { en: "playmat", note: "Accessory, not a card" },
  "スリーブ": { en: "sleeves", note: "Accessory, not a card" },
  "ケース": { en: "case", note: "Accessory" },
};

// =============================================================================
// EXCLUSION TERMS — high-confidence "this is NOT a single card listing"
// =============================================================================
// The matcher's filter pipeline drops listings whose titles contain any of
// these tokens. These are the noise sources (lots, sealed, accessories,
// fakes) that pollute median-price calculations.
export const HARD_EXCLUDE_TOKENS = [
  "セット",
  "まとめ",
  "まとめ売り",
  "セット販売",
  "デッキ",
  "ボックス",
  "BOX",
  "未開封BOX",
  "ブースター",
  "プレイマット",
  "スリーブ",
  "ケース",
  "オリパ",
  "ジュニア",        // junior accessory
  "プロモ未開封",      // sealed promo product
  "復刻",           // reprints — different physical card from vintage original
];

// =============================================================================
// ALL MAPS combined (for gloss tool's lookup)
// =============================================================================
export const ALL_GLOSSARY_ENTRIES = [
  ...Object.entries(ERA_MARKERS).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "era" })),
  ...Object.entries(EDITION_MARKERS).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "edition" })),
  ...Object.entries(CONDITION_TERMS).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "condition" })),
  ...Object.entries(GRADING_TERMS).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "grading" })),
  ...Object.entries(RARITY_TERMS).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "rarity" })),
  ...Object.entries(POKEMON_NAMES).map(([k, v]) => ({ jp: k, en: v, note: "", category: "pokemon" })),
  ...Object.entries(TRAINER_PREFIXES).map(([k, v]) => ({ jp: k, en: v, note: "Trainer/region possessive prefix — changes the canonical card identity", category: "trainer_prefix" })),
  ...Object.entries(SET_NAMES).map(([k, v]) => ({ jp: k, en: v, note: "", category: "set" })),
  ...Object.entries(LISTING_PHRASES).map(([k, v]) => ({ jp: k, en: v.en, note: v.note, category: "phrase" })),
];

// Sort by descending JP length so we match longer phrases first (e.g.,
// "未開封BOX" before "BOX", "拡張シート" before "拡張").
export const ALL_GLOSSARY_SORTED = [...ALL_GLOSSARY_ENTRIES].sort(
  (a, b) => b.jp.length - a.jp.length,
);

#!/usr/bin/env node
/**
 * Augment canonical_cards.search_doc_norm for JP cards so they're
 * findable by English-collector terms.
 *
 * The Scrydex importer stores set_name as the literal English
 * translation of the JP set name — "拡張パック" → "Expansion Pack",
 * "金、銀、新世界へ" → "Gold, Silver, to a New World". But every English-
 * speaking collector searches by the EN-release equivalent — "Base Set",
 * "Neo Genesis", "Gym Heroes". Without an alias layer, "Charizard JP base
 * set" returns zero results because the search is a conjunctive token
 * match against search_doc_norm and "base set" never appears there.
 *
 * Fix: append per-card extras to search_doc_norm:
 *   - "jp" + "japanese" — language tag
 *   - canonical_name_native (リザードン) — Japanese name
 *   - set_name_native (拡張パック) — Japanese set name
 *   - JP_SET_EN_EQUIV[set_name_native] — collector-shorthand EN set
 *
 * Idempotent: re-running won't compound aliases because we recompute
 * search_doc_norm from scratch each time.
 *
 * Usage:
 *   node scripts/augment-jp-search-doc.mjs              # all JP cards
 *   node scripts/augment-jp-search-doc.mjs --dry-run    # show first 10, no writes
 *   node scripts/augment-jp-search-doc.mjs --slug=expansion-pack-6-charizard-jp
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeSearchText, buildCanonicalSearchDoc } from "../lib/search/normalize.mjs";

dotenv.config({ path: ".env.local" });

// JP set name → space-separated EN equivalents the user is likely to
// search by. Multiple terms allowed: "Pokemon Card 151" expands to
// "pokemon card 151" + bare "151".
const JP_SET_EN_EQUIV = {
  // Vintage Base/Jungle/Fossil/Team Rocket era
  "拡張パック": "base set",
  "ポケモンジャングル": "jungle",
  "化石の秘密": "fossil mystery of the fossils",
  "ロケット団": "team rocket",
  // Vintage Gym era
  "リーダーズスタジアム": "gym heroes leaders stadium",
  "闇からの挑戦": "gym challenge challenge from the darkness",
  // Vintage Neo era
  "金、銀、新世界へ": "neo genesis gold silver",
  "遺跡をこえて": "neo discovery crossing ruins",
  "めざめる伝説": "neo revelation awakening legends",
  "闇、そして光へ": "neo destiny darkness light",
  // Vending / Promo / Premium
  "拡張シート": "vending machine sheet",
  "プレミアムファイル1": "neo premium file premium file 1",
  "プレミアムファイル2": "neo premium file premium file 2",
  "プレミアムファイル3": "neo premium file premium file 3",
  // e-card / ADV (2002-2004)
  "基本拡張パック": "base expansion pack pokemon card e ecard",
  "ポケモンカード★web": "pokemon web ecard",
  "ポケモンカード★VS": "pokemon vs ecard",
  "拡張パック": "base set", // duplicate but JS Map semantics — last wins
  "とかれた封印": "undone seal",
  "マグマVSアクア ふたつの野望": "magma aqua two ambitions",
  "天空の覇者": "rulers heavens",
  "砂漠のきせき": "miracle desert",
  // PCG / Holon era
  "さいはての攻防": "delta species offense defense furthest ends",
  "ホロンの幻影": "holon phantom",
  "ホロンの研究塔": "holon research tower",
  "きせきの結晶": "miracle crystal",
  "まぼろしの森": "mirage forest",
  "金の空、銀の海": "golden sky silvery ocean",
  "蒼空の激突": "clash blue sky",
  "伝説の飛翔": "flight legends",
  "ロケット団の逆襲": "rocket gang strikes back",
  // DP / Pt / HG-SS era
  "時空の創造": "diamond pearl space time creation",
  "湖の秘密": "secret lakes mysterious treasures",
  "破空の激闘": "intense fight destroyed sky",
  "ギンガの覇道": "galactic conquest",
  "アルセウス光臨": "advent arceus arceus",
  "ハートゴールドコレクション": "heartgold collection hgss",
  "ソウルシルバーコレクション": "soulsilver collection hgss",
  "よみがえる伝説": "reviving legends triumphant",
  "頂上大激突": "clash summit",
  // BW era
  "ブラックコレクション": "black collection black white",
  "ホワイトコレクション": "white collection black white",
  "レッドコレクション": "red collection",
  "ダークラッシュ": "dark rush dark explorers",
  "ドラゴンセレクション": "dragon selection",
  "プラズマゲイル": "plasma gale plasma freeze",
  "メガロキャノン": "megalo cannon legendary treasures",
  // XY era
  "コレクションX": "collection x xy base",
  "コレクションY": "collection y xy base",
  "ワイルドブレイズ": "wild blaze flashfire",
  "ライジングフィスト": "rising fist furious fists",
  "ファントムゲート": "phantom gate phantom forces",
  "ガイアボルケーノ": "gaia volcano primal clash",
  "タイダルストーム": "tidal storm primal clash",
  "バンデットリング": "bandit ring roaring skies",
  "エメラルドブレイク": "emerald break ancient origins",
  "破天の怒り": "rage broken heavens breakthrough",
  "赤い閃光": "red flash breakpoint",
  "青い衝撃": "blue shock breakpoint",
  "めざめる超王": "awakening psychic king fates collide",
  "爆熱の闘士": "fever burst fighter steam siege",
  "冷酷の反逆者": "cruel traitor steam siege",
  "拡張パック 20th Anniversary": "expansion pack 20th anniversary evolutions",
  "ザ・ベスト・オブ・XY": "best xy",
  // SM era
  "コレクション サン": "collection sun sun moon",
  "コレクション ムーン": "collection moon sun moon",
  "サン＆ムーン": "sun moon strength expansion",
  "新たなる試練の向こう": "facing new trial guardians rising",
  "キミを待つ島々": "islands await guardians rising",
  "アローラの月光": "alolan moonlight burning shadows",
  "闘う虹を見たか": "battle rainbow burning shadows",
  "光を喰らう闇": "darkness consumes light burning shadows",
  "ひかる伝説": "shining legends",
  "GXバトルブースト": "gx battle boost crimson invasion",
  "覚醒の勇者": "awakened heroes ultra prism",
  "超次元の暴獣": "ultradimensional beasts forbidden light",
  "ウルトラサン": "ultra sun ultra prism",
  "ウルトラムーン": "ultra moon ultra prism",
  "ウルトラフォース": "ultra force celestial storm",
  "禁断の光": "forbidden light",
  "ドラゴンストーム": "dragon storm dragon majesty",
  "チャンピオンロード": "champion road celestial storm",
  "裂空のカリスマ": "sky splitting charisma celestial storm",
  "迅雷スパーク": "thunderclap spark thunderclap",
  "フェアリーライズ": "fairy rise lost thunder",
  "超爆インパクト": "super burst impact lost thunder",
  "ダークオーダー": "dark order team up",
  "GXウルトラシャイニー": "gx ultra shiny hidden fates",
  "ピカチュウと新しい仲間たち": "pikachu new friends",
  "タッグボルト": "tag bolt unbroken bonds",
  "ナイトユニゾン": "night unison unified minds",
  "フルメタルウォール": "full metal wall unified minds",
  "ダブルブレイズ": "double blaze cosmic eclipse",
  "ジージーエンド": "gg end cosmic eclipse",
  "スカイレジェンド": "sky legend",
  "ミラクルツイン": "miracle twin",
  "リミックスバウト": "remix bout",
  "ドリームリーグ": "dream league",
  "オルタージェネシス": "alter genesis cosmic eclipse",
  "TAG TEAM GX タッグオールスターズ": "tag team gx all stars",
  // SWSH era
  "ソード": "sword shield base",
  "シールド": "sword shield base",
  "VMAXライジング": "vmax rising rebel clash",
  "反逆クラッシュ": "rebellion crash rebel clash",
  "爆炎ウォーカー": "explosive walker champions path",
  "ムゲンゾーン": "infinity zone darkness ablaze",
  "伝説の鼓動": "legendary heartbeat champions path",
  "仰天のボルテッカー": "amazing volt tackle vivid voltage",
  "シャイニースターV": "shiny star v shining fates",
  "一撃マスター": "single strike master battle styles",
  "連撃マスター": "rapid strike master battle styles",
  "双璧のファイター": "peerless fighters chilling reign",
  "白銀のランス": "silver lance chilling reign",
  "漆黒のガイスト": "jet black spirit chilling reign",
  "イーブイヒーローズ": "eevee heroes evolving skies",
  "摩天パーフェクト": "skyscraping perfection chilling reign",
  "蒼空ストリーム": "blue sky stream evolving skies",
  "フュージョンアーツ": "fusion arts fusion strike",
  "25th Anniversary Collection": "25th anniversary collection celebrations",
  "VMAXクライマックス": "vmax climax brilliant stars",
  "スターバース": "star birth brilliant stars",
  "バトルリージョン": "battle region astral radiance",
  "タイムゲイザー": "time gazer astral radiance",
  "スペースジャグラ": "space juggler astral radiance",
  "ダークファンタズマ": "dark phantasma astral radiance",
  "Pokémon GO": "pokemon go",
  "ロストアビス": "lost abyss lost origin",
  "白熱のアルカナ": "incandescent arcana lost origin",
  "パラダイムトリガー": "paradigm trigger silver tempest",
  "VSTARユニバース": "vstar universe crown zenith",
  // SV era
  "スカーレットex": "scarlet ex scarlet violet base",
  "バイオレットex": "violet ex scarlet violet base",
  "トリプレットビート": "triplet beat paldea evolved",
  "スノーハザード": "snow hazard paldean fates",
  "クレイバースト": "clay burst paldean fates",
  "ポケモンカード151": "pokemon card 151 151",
  "黒炎の支配者": "ruler black flame obsidian flames",
  "レイジングサーフ": "raging surf paradox rift",
  "古代の咆哮": "ancient roar paradox rift",
  "未来の一閃": "future flash paradox rift",
  "シャイニートレジャーex": "shiny treasure ex paldean fates",
  "ワイルドフォース": "wild force temporal forces",
  "サイバージャッジ": "cyber judge temporal forces",
  "クリムゾンヘイズ": "crimson haze twilight masquerade",
  "変幻の仮面": "mask change twilight masquerade",
  "ナイトワンダラー": "night wanderer shrouded fable",
  "ステラミラクル": "stellar miracle stellar crown",
  "楽園ドラゴーナ": "paradise dragona surging sparks",
  "超電ブレイカー": "super electric breaker stellar crown",
  "テラスタルフェスex": "terastal festival ex paldean",
  "バトルパートナーズ": "battle partners journey together",
  "熱風のアリーナ": "hot air arena prismatic evolutions",
  "ロケット団の栄光": "glory team rocket team rocket destined rivals",
  "ホワイトフレア": "white flare white flare",
  "ブラックボルト": "black bolt black bolt",
  // Mega era (2026+)
  "メガブレイブ": "mega brave",
  "メガシンフォニア": "mega symphonia",
  "インフェルノX": "inferno x",
  "MEGAドリームex": "mega dream ex",
  "ムニキスゼロ": "nihil zero",
  "ニンジャスピナー": "ninja spinner",
};

const PAGE_SIZE = 1000;
const PARALLEL = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, slugs: [] };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--slug=")) opts.slugs.push(a.slice("--slug=".length));
    else if (a.startsWith("--slugs=")) opts.slugs.push(...a.slice("--slugs=".length).split(",").filter(Boolean));
  }
  return opts;
}

function buildAugmentedSearchDoc(card) {
  // Reproduce the importer's search_doc layout, then add JP-specific extras.
  // buildCanonicalSearchDoc accepts the same fields the importer sends.
  const baseDoc = buildCanonicalSearchDoc({
    canonical_name: card.canonical_name,
    subject: card.subject ?? card.canonical_name,
    set_name: card.set_name,
    card_number: card.card_number,
    year: card.year,
  });

  const extras = [
    "jp",
    "japanese",
    card.canonical_name_native ?? "",
    card.set_name_native ?? "",
    JP_SET_EN_EQUIV[card.set_name_native?.trim() ?? ""] ?? "",
  ].filter(Boolean);

  const combined = [baseDoc, ...extras].filter(Boolean).join(" ");
  return {
    search_doc: combined,
    search_doc_norm: normalizeSearchText(combined),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  console.log(`[augment-jp-search-doc] dry-run: ${opts.dryRun}`);

  // Page through JP canonical_cards
  const all = [];
  if (opts.slugs.length > 0) {
    const { data, error } = await supabase
      .from("canonical_cards")
      .select("slug, canonical_name, subject, set_name, set_name_native, canonical_name_native, card_number, year, search_doc_norm, language")
      .in("slug", opts.slugs);
    if (error) throw error;
    all.push(...(data ?? []));
  } else {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("canonical_cards")
        .select("slug, canonical_name, subject, set_name, set_name_native, canonical_name_native, card_number, year, search_doc_norm, language")
        .eq("language", "JP")
        .order("slug")
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
  }

  console.log(`[augment-jp-search-doc] processing ${all.length} JP card(s)`);

  let updated = 0;
  let unchanged = 0;
  let missingSetEquiv = new Set();
  const previewPairs = [];

  for (let i = 0; i < all.length; i += PARALLEL) {
    const batch = all.slice(i, i + PARALLEL);
    const ops = batch.map(async (card) => {
      const augmented = buildAugmentedSearchDoc(card);
      const wantsUpdate = augmented.search_doc_norm !== card.search_doc_norm;
      const setNameNative = card.set_name_native?.trim() ?? "";
      if (setNameNative && !JP_SET_EN_EQUIV[setNameNative]) missingSetEquiv.add(setNameNative);

      if (previewPairs.length < 10) {
        previewPairs.push({ slug: card.slug, before: card.search_doc_norm?.slice(0, 80), after: augmented.search_doc_norm?.slice(0, 100) });
      }

      if (!wantsUpdate) return { ok: true, changed: false };
      if (opts.dryRun) return { ok: true, changed: true };

      const { error } = await supabase
        .from("canonical_cards")
        .update({
          search_doc: augmented.search_doc,
          search_doc_norm: augmented.search_doc_norm,
        })
        .eq("slug", card.slug);
      if (error) return { ok: false, slug: card.slug, error: error.message };
      return { ok: true, changed: true };
    });
    const results = await Promise.all(ops);
    for (const r of results) {
      if (!r.ok) {
        console.error(`  failed ${r.slug}: ${r.error}`);
      } else if (r.changed) {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    if (i % 1000 === 0 && i > 0) {
      console.log(`  progress: ${i}/${all.length} (updated=${updated}, unchanged=${unchanged})`);
    }
  }

  console.log("");
  console.log("[augment-jp-search-doc] sample (first 10):");
  for (const p of previewPairs) {
    console.log(`  ${p.slug}`);
    console.log(`    before: ${p.before}`);
    console.log(`    after:  ${p.after}`);
  }

  if (missingSetEquiv.size > 0) {
    console.log("");
    console.log(`[augment-jp-search-doc] ${missingSetEquiv.size} JP set name(s) lacked an EN-equivalent in JP_SET_EN_EQUIV:`);
    const sorted = [...missingSetEquiv].sort();
    for (const s of sorted.slice(0, 30)) console.log(`  "${s}": "?"`);
    if (sorted.length > 30) console.log(`  ... (${sorted.length - 30} more)`);
    console.log("  Cards in these sets are still findable by canonical_name + JP language tag,");
    console.log("  but won't match an EN-equivalent set search until added.");
  }

  console.log("");
  console.log(`[augment-jp-search-doc] DONE: updated=${updated} unchanged=${unchanged}${opts.dryRun ? " (DRY RUN — no writes)" : ""}`);
}

main().catch((err) => {
  console.error("[augment-jp-search-doc] FAILED:", err);
  process.exit(1);
});

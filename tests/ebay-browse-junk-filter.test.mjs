import assert from "node:assert/strict";
import {
  isJunkListingTitle,
  normalizeListingText,
} from "../lib/ebay/listing-junk-filter.ts";

// Each case locks a failure mode that shipped (or nearly shipped)
// during PR #241's review — see the case labels. Extend this matrix
// BEFORE changing JUNK_LISTING_PATTERNS or isJunkListingTitle.
export function runEbayBrowseJunkFilterTests() {
  const junk = (title, name, set) =>
    isJunkListingTitle(normalizeListingText(title), [
      normalizeListingText(name),
      normalizeListingText(set),
    ]);

  const cases = [
    // Original report (PR #241): lottery listing advertising the chase
    // card's name + number sails through the relevance gates.
    {
      label: "original: MYSTERY GRAB listing filtered",
      title: "Pokemon Mega Gengar EX 284/217 Ascended Heroes MYSTERY GRAB, READ DESCRIPTION",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: true,
    },
    // Codex P2 #1: legit single from a set whose EN name contains a
    // junk token ("Mystery of the Fossils" = 化石の秘密 in lib/jp/glossary).
    {
      label: "P2#1: legit mystery-set single kept",
      title: "Aerodactyl Mystery of the Fossils Japanese NM",
      name: "Aerodactyl",
      set: "Mystery of the Fossils",
      junk: false,
    },
    // Codex P2 #2: lottery pack must STILL be filtered when the
    // requested set itself is mystery-named.
    {
      label: "P2#2: lottery pack in mystery-named set filtered",
      title: "Dragonite 4 Mystery Pack Chase Mystery of the Fossils",
      name: "Dragonite",
      set: "Mystery of the Fossils",
      junk: true,
    },
    // Codex P2 #3: "mystery" as legitimate metadata outside the
    // requested phrases (Mystery Dungeon promos are real singles).
    {
      label: "P2#3: Mystery Dungeon promo single kept",
      title: "Pokemon Mystery Dungeon Rescue Team DX Pikachu 036/S-P Promo NM",
      name: "Pikachu",
      set: "S-P Promo",
      junk: false,
    },
    {
      label: "P2#3 guard: Mystery Dungeon Box single kept (allowlist, not \\w+ gap)",
      title: "Pikachu Mystery Dungeon Box Promo 036/S-P NM",
      name: "Pikachu",
      set: "S-P Promo",
      junk: false,
    },
    // Codex P2 #4: intervening product words between "mystery" and the
    // lottery noun.
    {
      label: "P2#4: Mystery Pokemon Pack filtered",
      title: "Mega Gengar ex 284 Mystery Pokemon Pack",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: true,
    },
    {
      label: "P2#4: Mystery Card Lot filtered",
      title: "Ascended Heroes Mystery Card Lot chase Mega Gengar ex",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: true,
    },
    {
      label: "P2#4: accented Pokémon between mystery and pack (normalizes to 'pok mon')",
      title: "Mega Gengar ex 284 Mystery Pokémon Pack",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: true,
    },
    // Adjacent-noun and other junk vocab still fire.
    {
      label: "mystery box adjacent filtered",
      title: "Mega Gengar ex chase MYSTERY BOX 284",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: true,
    },
    {
      label: "grab bag filtered even inside mystery-named set",
      title: "Mystery of the Fossils GRAB BAG Aerodactyl",
      name: "Aerodactyl",
      set: "Mystery of the Fossils",
      junk: true,
    },
    {
      label: "oripa filtered (null set name)",
      title: "Japanese ORIPA Mega Gengar ex chance",
      name: "Mega Gengar ex",
      set: null,
      junk: true,
    },
    // Plain listings never trip.
    {
      label: "normal listing kept",
      title: "Mega Gengar EX 284/217 SIR Ascended Heroes NM",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: false,
    },
    {
      label: "repeated set phrase fully stripped",
      title: "Mystery of the Fossils lot Mystery of the Fossils Aerodactyl NM",
      name: "Aerodactyl",
      set: "Mystery of the Fossils",
      junk: false,
    },
    // Documented tradeoff: noun-less "mystery" passes — precision over
    // recall on a buying surface. If real leaks appear, add their noun
    // to the pattern and a case here.
    {
      label: "tradeoff: noun-less MYSTERY title passes",
      title: "Mega Gengar ex 284 MYSTERY read description",
      name: "Mega Gengar ex",
      set: "Ascended Heroes",
      junk: false,
    },
  ];

  for (const c of cases) {
    assert.equal(junk(c.title, c.name, c.set), c.junk, c.label);
  }

  // Word-boundary sanity: "mysterious" must never match \bmystery\b.
  // The set is deliberately NOT passed so "mysterious" survives the
  // phrase-strip and sits in the tested residual right before "pack".
  assert.equal(
    junk("Garchomp 9/123 Mysterious holo pack deal", "Garchomp", null),
    false,
    "residual 'mysterious holo pack' never matches \\bmystery\\b",
  );
}

runEbayBrowseJunkFilterTests();

console.log("ebay browse junk filter tests passed");

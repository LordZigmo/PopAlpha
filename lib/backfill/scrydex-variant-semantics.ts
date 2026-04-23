export type ScrydexNormalizedFinish = "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
export type ScrydexNormalizedEdition = "UNLIMITED" | "FIRST_EDITION";

type SpecialVariantSpec = {
  aliases: string[];
  normalizedStamp: string;
  stampLabel: string;
  forcedFinish: ScrydexNormalizedFinish | null;
  specialVariantToken: string;
};

// Mirror of public.normalize_scrydex_stamp() in
// supabase/migrations/20260423040000_phase3a_stamp_classifier_and_remap.sql.
// Keep DB and TS vocabularies in lockstep — stamp value names must match
// the values stored in public.card_printings.stamp exactly.
const SPECIAL_VARIANT_SPECS: SpecialVariantSpec[] = [
  {
    aliases: ["pokemoncenterstamp", "pokemoncenter"],
    normalizedStamp: "POKEMON_CENTER",
    stampLabel: "pokemon center",
    forcedFinish: null,
    specialVariantToken: "pokemoncenterstamp",
  },
  {
    aliases: ["masterballreverseholofoil", "masterballreverseholo", "masterball"],
    normalizedStamp: "MASTER_BALL_PATTERN",
    stampLabel: "master ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "masterballreverseholofoil",
  },
  {
    aliases: ["pokeballreverseholofoil", "pokeballreverseholo", "pokeball"],
    normalizedStamp: "POKE_BALL_PATTERN",
    stampLabel: "poke ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "pokeballreverseholofoil",
  },
  {
    aliases: ["duskballreverseholofoil", "duskballreverseholo", "duskball"],
    normalizedStamp: "DUSK_BALL_PATTERN",
    stampLabel: "dusk ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "duskballreverseholofoil",
  },
  {
    aliases: ["quickballreverseholofoil", "quickballreverseholo", "quickball"],
    normalizedStamp: "QUICK_BALL_PATTERN",
    stampLabel: "quick ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "quickballreverseholofoil",
  },
  {
    aliases: ["greatballreverseholofoil", "greatballreverseholo", "greatball"],
    normalizedStamp: "GREAT_BALL_PATTERN",
    stampLabel: "great ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "greatballreverseholofoil",
  },
  {
    aliases: ["ultraballreverseholofoil", "ultraballreverseholo", "ultraball"],
    normalizedStamp: "ULTRA_BALL_PATTERN",
    stampLabel: "ultra ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "ultraballreverseholofoil",
  },
  {
    aliases: ["friendballreverseholofoil", "friendballreverseholo", "friendball"],
    normalizedStamp: "FRIEND_BALL_PATTERN",
    stampLabel: "friend ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "friendballreverseholofoil",
  },
  {
    aliases: ["loveballreverseholofoil", "loveballreverseholo", "loveball"],
    normalizedStamp: "LOVE_BALL_PATTERN",
    stampLabel: "love ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "loveballreverseholofoil",
  },
  {
    aliases: ["heavyballreverseholofoil", "heavyballreverseholo", "heavyball"],
    normalizedStamp: "HEAVY_BALL_PATTERN",
    stampLabel: "heavy ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "heavyballreverseholofoil",
  },
  {
    aliases: ["levelballreverseholofoil", "levelballreverseholo", "levelball"],
    normalizedStamp: "LEVEL_BALL_PATTERN",
    stampLabel: "level ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "levelballreverseholofoil",
  },
  {
    aliases: ["dreamballreverseholofoil", "dreamballreverseholo", "dreamball"],
    normalizedStamp: "DREAM_BALL_PATTERN",
    stampLabel: "dream ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "dreamballreverseholofoil",
  },
  {
    aliases: ["premierballreverseholofoil", "premierballreverseholo", "premierball"],
    normalizedStamp: "PREMIER_BALL_PATTERN",
    stampLabel: "premier ball",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "premierballreverseholofoil",
  },
  {
    aliases: ["energyreverseholofoil", "energyreverseholo", "energysymbolpattern", "energysymbol"],
    normalizedStamp: "ENERGY_SYMBOL_PATTERN",
    stampLabel: "energy",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "energyreverseholofoil",
  },
  {
    aliases: ["rocketreverseholofoil", "rocketreverseholo", "teamrocket", "rocket"],
    normalizedStamp: "TEAM_ROCKET",
    stampLabel: "team rocket",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "rocketreverseholofoil",
  },
  {
    aliases: ["cosmosholofoil", "cosmos"],
    normalizedStamp: "COSMOS_HOLO",
    stampLabel: "cosmos",
    forcedFinish: "HOLO",
    specialVariantToken: "cosmosholofoil",
  },
  {
    aliases: ["crackediceholofoil", "crackedice"],
    normalizedStamp: "CRACKED_ICE_HOLO",
    stampLabel: "cracked ice",
    forcedFinish: "HOLO",
    specialVariantToken: "crackediceholofoil",
  },
  {
    aliases: ["tinselholofoil", "tinselholo"],
    normalizedStamp: "TINSEL_HOLO",
    stampLabel: "tinsel",
    forcedFinish: "HOLO",
    specialVariantToken: "tinselholofoil",
  },
  {
    aliases: ["playpokemonstampholofoil", "playpokemonstamp"],
    normalizedStamp: "PLAY_POKEMON_STAMP",
    stampLabel: "play! pokemon",
    forcedFinish: null,
    specialVariantToken: "playpokemonstamp",
  },
  {
    aliases: ["leaguestamp"],
    normalizedStamp: "LEAGUE_STAMP",
    stampLabel: "league",
    forcedFinish: null,
    specialVariantToken: "leaguestamp",
  },
  {
    aliases: ["league1stplacestamp", "league1stplace"],
    normalizedStamp: "LEAGUE_1ST_PLACE",
    stampLabel: "league 1st place",
    forcedFinish: null,
    specialVariantToken: "league1stplacestamp",
  },
  {
    aliases: ["league2ndplacestamp", "league2ndplace"],
    normalizedStamp: "LEAGUE_2ND_PLACE",
    stampLabel: "league 2nd place",
    forcedFinish: null,
    specialVariantToken: "league2ndplacestamp",
  },
  {
    aliases: ["league3rdplacestamp", "league3rdplace"],
    normalizedStamp: "LEAGUE_3RD_PLACE",
    stampLabel: "league 3rd place",
    forcedFinish: null,
    specialVariantToken: "league3rdplacestamp",
  },
  {
    aliases: ["league4thplacestamp", "league4thplace"],
    normalizedStamp: "LEAGUE_4TH_PLACE",
    stampLabel: "league 4th place",
    forcedFinish: null,
    specialVariantToken: "league4thplacestamp",
  },
  {
    aliases: ["staffstamp", "staff"],
    normalizedStamp: "STAFF_STAMP",
    stampLabel: "staff",
    forcedFinish: null,
    specialVariantToken: "staffstamp",
  },
  {
    aliases: ["holidaystamp"],
    normalizedStamp: "HOLIDAY_STAMP",
    stampLabel: "holiday",
    forcedFinish: null,
    specialVariantToken: "holidaystamp",
  },
  {
    aliases: ["expansionstamp"],
    normalizedStamp: "EXPANSION_STAMP",
    stampLabel: "expansion",
    forcedFinish: null,
    specialVariantToken: "expansionstamp",
  },
  {
    aliases: ["burgerkingstamp", "burgerking"],
    normalizedStamp: "BURGER_KING_STAMP",
    stampLabel: "burger king",
    forcedFinish: null,
    specialVariantToken: "burgerkingstamp",
  },
  {
    aliases: ["peelabledittoholofoil", "peelableditto"],
    normalizedStamp: "PEELABLE_DITTO",
    stampLabel: "peelable ditto",
    forcedFinish: null,
    specialVariantToken: "peelableditto",
  },
  {
    aliases: ["wstamp"],
    normalizedStamp: "W_STAMP",
    stampLabel: "w stamp",
    forcedFinish: null,
    specialVariantToken: "wstamp",
  },
  {
    aliases: ["prereleasestamp", "prerelease"],
    normalizedStamp: "PRERELEASE",
    stampLabel: "prerelease",
    forcedFinish: null,
    specialVariantToken: "prereleasestamp",
  },
  // Phase 3b: shadowless is modeled as a stamp overlay on an edition.
  // The alias pattern is a substring match, so it fires for plain
  // 'unlimitedshadowless' / 'firsteditionshadowless' AND compound
  // 'unlimitedshadowlessholofoil' etc. Edition + finish are still
  // derived from the surrounding token segments.
  {
    aliases: ["shadowless"],
    normalizedStamp: "SHADOWLESS",
    stampLabel: "shadowless",
    forcedFinish: null,
    specialVariantToken: "shadowless",
  },
];

export type ScrydexVariantSemantics = {
  providerVariantToken: string;
  providerFinish: string | null;
  normalizedFinish: ScrydexNormalizedFinish;
  normalizedEdition: ScrydexNormalizedEdition;
  normalizedStamp: string;
  stampLabel: string | null;
  hasSpecialVariantToken: boolean;
  specialVariantToken: string | null;
};

function normalizeTextToken(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function detectNormalizedFinish(providerVariantToken: string): ScrydexNormalizedFinish {
  if (!providerVariantToken || providerVariantToken === "unknown") return "UNKNOWN";
  if (providerVariantToken.includes("reverse")) return "REVERSE_HOLO";
  if (
    providerVariantToken === "normal"
    || providerVariantToken === "nonholo"
    || providerVariantToken === "nonholofoil"
  ) {
    return "NON_HOLO";
  }
  if (providerVariantToken.includes("holo") || providerVariantToken.includes("foil")) {
    return "HOLO";
  }
  return "UNKNOWN";
}

function findSpecialVariantSpec(providerVariantToken: string): SpecialVariantSpec | null {
  for (const spec of SPECIAL_VARIANT_SPECS) {
    if (spec.aliases.some((alias) => providerVariantToken.includes(alias))) return spec;
  }
  return null;
}

export function normalizeScrydexVariantToken(value: string | null | undefined): string {
  return normalizeTextToken(value);
}

export function normalizeScrydexStampToken(value: string | null | undefined): string {
  const token = normalizeTextToken(value);
  if (!token) return "NONE";
  const spec = findSpecialVariantSpec(token);
  if (spec) return spec.normalizedStamp;
  if (token === "none" || token === "nostamp") return "NONE";
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "NONE";
}

export function hasScrydexSpecialVariantToken(value: string | null | undefined): boolean {
  const token = normalizeTextToken(value);
  if (!token) return false;
  return findSpecialVariantSpec(token) !== null;
}

export function parseScrydexVariantSemantics(variantName: string): ScrydexVariantSemantics {
  const providerVariantToken = normalizeTextToken(variantName);
  const specialSpec = findSpecialVariantSpec(providerVariantToken);
  const normalizedEdition: ScrydexNormalizedEdition = (
    providerVariantToken.includes("1stedition")
    || providerVariantToken.includes("firstedition")
  ) ? "FIRST_EDITION" : "UNLIMITED";

  let normalizedFinish = detectNormalizedFinish(providerVariantToken);
  if (specialSpec?.forcedFinish) normalizedFinish = specialSpec.forcedFinish;

  return {
    providerVariantToken,
    providerFinish: variantName || null,
    normalizedFinish,
    normalizedEdition,
    normalizedStamp: specialSpec?.normalizedStamp ?? "NONE",
    stampLabel: specialSpec?.stampLabel ?? null,
    hasSpecialVariantToken: specialSpec !== null,
    specialVariantToken: specialSpec?.specialVariantToken ?? null,
  };
}

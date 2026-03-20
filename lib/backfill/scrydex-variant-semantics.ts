export type ScrydexNormalizedFinish = "NON_HOLO" | "HOLO" | "REVERSE_HOLO" | "UNKNOWN";
export type ScrydexNormalizedEdition = "UNLIMITED" | "FIRST_EDITION";

type SpecialVariantSpec = {
  aliases: string[];
  normalizedStamp: string;
  stampLabel: string;
  forcedFinish: ScrydexNormalizedFinish | null;
  specialVariantToken: string;
};

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
    aliases: ["energyreverseholofoil", "energyreverseholo", "energysymbolpattern", "energysymbol"],
    normalizedStamp: "ENERGY_PATTERN",
    stampLabel: "energy",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "energyreverseholofoil",
  },
  {
    aliases: ["rocketreverseholofoil", "rocketreverseholo", "teamrocket", "rocket"],
    normalizedStamp: "ROCKET_PATTERN",
    stampLabel: "rocket",
    forcedFinish: "REVERSE_HOLO",
    specialVariantToken: "rocketreverseholofoil",
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
    normalizedStamp: "PRERELEASE_STAMP",
    stampLabel: "prerelease",
    forcedFinish: null,
    specialVariantToken: "prereleasestamp",
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

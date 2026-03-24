const DIGITAL_POKEMON_SET_CODE_PREFIX = "tcgp-";

const DIGITAL_POKEMON_SET_NAMES = new Set([
  "genetic apex",
  "mythical island",
  "promo-a",
  "space-time smackdown",
  "triumphant light",
  "shining revelry",
  "celestial guardians",
  "extradimensional crisis",
  "eevee grove",
  "wisdom of sea and sky",
  "secluded springs",
  "deluxe pack ex",
  "mega rising",
  "promo-b",
]);

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isDigitalPokemonSetCode(setCode: string | null | undefined): boolean {
  return normalize(setCode).startsWith(DIGITAL_POKEMON_SET_CODE_PREFIX);
}

export function isDigitalPokemonSetName(setName: string | null | undefined): boolean {
  return DIGITAL_POKEMON_SET_NAMES.has(normalize(setName));
}

export function isNonPhysicalPokemonSet(input: {
  setCode?: string | null | undefined;
  setName?: string | null | undefined;
}): boolean {
  return isDigitalPokemonSetCode(input.setCode) || isDigitalPokemonSetName(input.setName);
}

export function isPhysicalPokemonSet(input: {
  setCode?: string | null | undefined;
  setName?: string | null | undefined;
}): boolean {
  return !isNonPhysicalPokemonSet(input);
}

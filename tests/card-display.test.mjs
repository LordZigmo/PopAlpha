import assert from "node:assert/strict";
import { displayNameFromCanonicalSlug } from "../lib/card-display.mjs";

export function runCardDisplayTests() {
  assert.equal(
    displayNameFromCanonicalSlug("journey-together-152-n-s-castle", {
      setName: "Journey Together",
      cardNumber: "152",
    }),
    "N's Castle",
  );

  assert.equal(
    displayNameFromCanonicalSlug("journey-together-117-hop-s-snorlax", {
      setName: "Journey Together",
      cardNumber: "117",
    }),
    "Hop's Snorlax",
  );

  assert.equal(
    displayNameFromCanonicalSlug("team-rocket-returns-12-team-rocket-s-meowth", {
      setName: "Team Rocket Returns",
      cardNumber: "12",
    }),
    "Team Rocket's Meowth",
  );

  assert.equal(displayNameFromCanonicalSlug("unown-s"), "Unown S");
}

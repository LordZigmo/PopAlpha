// Verification script for handle validation rules.
// Usage: node scripts/check-handle-validation.mjs
//
// Inlines the validation logic since Node can't import .ts directly.

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const DOUBLE_UNDERSCORE = /__/;

const RESERVED = new Set([
  "admin", "api", "cron", "debug", "help", "login", "logout", "me",
  "mod", "moderator", "null", "onboarding", "popalpha", "portfolio",
  "root", "search", "settings", "sign-in", "signin", "sign-up", "signup",
  "support", "system", "test", "undefined", "user",
]);

function validateHandle(raw) {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length < 3) return { valid: false, reason: "too short" };
  if (normalized.length > 20) return { valid: false, reason: "too long" };
  if (!HANDLE_RE.test(normalized)) return { valid: false, reason: "bad chars" };
  if (normalized.startsWith("_") || normalized.endsWith("_")) return { valid: false, reason: "underscore edge" };
  if (DOUBLE_UNDERSCORE.test(normalized)) return { valid: false, reason: "double underscore" };
  if (RESERVED.has(normalized)) return { valid: false, reason: "reserved" };
  return { valid: true, normalized };
}

function safeReturnTo(raw) {
  if (!raw) return "/";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return "/";
  if (trimmed.includes("://")) return "/";
  return trimmed;
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ── Valid handles ──────────────────────────────────────────────────────
console.log("Valid handles:");

for (const h of ["zig", "abc", "trader_joe", "a1b2c3", "handle_with_20chars"]) {
  const r = validateHandle(h);
  assert(r.valid, `"${h}" should be valid`);
  if (r.valid) assert(r.normalized === h.toLowerCase(), `"${h}" normalized correctly`);
}

// Mixed case normalizes to lowercase
const mixed = validateHandle("ZigTrader");
assert(mixed.valid && mixed.normalized === "zigtrader", "ZigTrader → zigtrader");

// ── Invalid: too short ────────────────────────────────────────────────
console.log("Too short:");
for (const h of ["", "a", "ab"]) {
  assert(!validateHandle(h).valid, `"${h}" should fail (too short)`);
}

// ── Invalid: too long ─────────────────────────────────────────────────
console.log("Too long:");
assert(!validateHandle("a".repeat(21)).valid, "21 chars should fail");

// ── Invalid: bad chars ────────────────────────────────────────────────
console.log("Bad characters:");
for (const h of ["has space", "has-dash", "has.dot", "HAS@AT", "has!bang"]) {
  assert(!validateHandle(h).valid, `"${h}" should fail (bad chars)`);
}

// ── Invalid: underscore rules ─────────────────────────────────────────
console.log("Underscore rules:");
assert(!validateHandle("_starts").valid, "_starts should fail");
assert(!validateHandle("ends_").valid, "ends_ should fail");
assert(!validateHandle("has__double").valid, "has__double should fail");

// ── Invalid: reserved words ───────────────────────────────────────────
console.log("Reserved words:");
for (const h of ["admin", "support", "popalpha", "api", "portfolio", "me", "null"]) {
  assert(!validateHandle(h).valid, `"${h}" should fail (reserved)`);
}

// ── safeReturnTo ──────────────────────────────────────────────────────
console.log("safeReturnTo:");
assert(safeReturnTo("/portfolio") === "/portfolio", "/portfolio passes");
assert(safeReturnTo("/portfolio?tab=holdings") === "/portfolio?tab=holdings", "with query passes");
assert(safeReturnTo(null) === "/", "null → /");
assert(safeReturnTo("") === "/", "empty → /");
assert(safeReturnTo("https://evil.com") === "/", "absolute URL blocked");
assert(safeReturnTo("javascript://alert(1)") === "/", "protocol blocked");
assert(safeReturnTo("/foo://bar") === "/", "embedded protocol blocked");

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("Handle validation checks passed");

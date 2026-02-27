import { randomBytes } from "crypto";

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

const fromSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
const fromVercelUrl = process.env.VERCEL_URL?.trim();

let baseUrl = "http://localhost:3000";
if (fromSiteUrl) {
  baseUrl = stripTrailingSlash(fromSiteUrl);
} else if (fromVercelUrl) {
  baseUrl = `https://${stripTrailingSlash(fromVercelUrl)}`;
}

let token = process.env.EBAY_VERIFICATION_TOKEN?.trim() ?? "";
if (!token) {
  token = randomBytes(32).toString("hex");
  console.warn("WARNING: EBAY_VERIFICATION_TOKEN is missing.");
  console.warn("Add this token to .env.local and Vercel Project Settings -> Environment Variables (Production + Preview).");
}

console.log(`ENDPOINT_URL=${baseUrl}/api/ebay/deletion-notification`);
console.log(`VERIFICATION_TOKEN=${token}`);


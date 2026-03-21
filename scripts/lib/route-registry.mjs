import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "app", "api");
const REGISTRY_PATH = path.join(ROOT, "lib", "auth", "route-registry.ts");

function extractArray(source, exportName) {
  const pattern = new RegExp(`export const ${exportName} = \\[(.*?)\\];`, "s");
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${exportName} in lib/auth/route-registry.ts`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

export function readRouteRegistry() {
  const source = fs.readFileSync(REGISTRY_PATH, "utf8");
  return {
    publicRoutes: new Set(extractArray(source, "PUBLIC_ROUTES")),
    cronRoutes: new Set(extractArray(source, "CRON_ROUTES")),
    adminRoutes: new Set(extractArray(source, "ADMIN_ROUTES")),
    debugRoutes: new Set(extractArray(source, "DEBUG_ROUTES")),
    ingestRoutes: new Set(extractArray(source, "INGEST_ROUTES")),
    userRoutes: new Set(extractArray(source, "USER_ROUTES")),
  };
}

export function routeKeyFromFilePath(filePath) {
  const rel = path.relative(API_DIR, filePath).replace(/\\/g, "/");
  return rel.replace(/\/route\.ts$/, "");
}

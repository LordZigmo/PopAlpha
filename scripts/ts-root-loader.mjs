import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FILE_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];
const INDEX_SUFFIXES = FILE_SUFFIXES.map((suffix) => path.join("index" + suffix));

function tryResolveBase(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  for (const suffix of FILE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const suffix of INDEX_SUFFIXES) {
      const candidate = path.join(basePath, suffix);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

function maybeResolveAlias(specifier) {
  if (!specifier.startsWith("@/")) return null;
  return tryResolveBase(path.join(ROOT, specifier.slice(2)));
}

function maybeResolveRelative(specifier, parentURL) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  if (!parentURL?.startsWith("file:")) return null;
  const parentPath = fileURLToPath(parentURL);
  const basePath = specifier.startsWith("/")
    ? specifier
    : path.resolve(path.dirname(parentPath), specifier);
  return tryResolveBase(basePath);
}

export async function resolve(specifier, context, nextResolve) {
  const aliased = maybeResolveAlias(specifier);
  if (aliased) {
    return {
      shortCircuit: true,
      url: pathToFileURL(aliased).href,
    };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fallback = maybeResolveRelative(specifier, context.parentURL);
    if (fallback) {
      return {
        shortCircuit: true,
        url: pathToFileURL(fallback).href,
      };
    }
    throw error;
  }
}

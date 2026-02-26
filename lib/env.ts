export function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Add it to your local env file and restart the dev server.`
    );
  }
  return value;
}

export function getRequiredEnvs(names: string[]): Record<string, string> {
  const missing: string[] = [];
  const values: Record<string, string> = {};

  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
      continue;
    }
    values[name] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Add them to your local env file and restart the dev server.`
    );
  }

  return values;
}

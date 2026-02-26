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
  const values: Record<string, string> = {};

  for (const name of names) {
    values[name] = getRequiredEnv(name);
  }

  return values;
}

export function getServerConfigErrorMessage(error: unknown): string {
  const details =
    error instanceof Error
      ? error.message
      : "Missing server Supabase environment configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.";

  return `Server configuration error: ${details}`;
}

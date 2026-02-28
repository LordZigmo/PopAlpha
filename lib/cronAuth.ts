export type CronAuthResult = {
  ok: boolean;
  deprecatedQueryAuth: boolean;
};

type CronAuthOptions = {
  allowDeprecatedQuerySecret?: boolean;
};

/**
 * Standard cron auth is Authorization: Bearer <CRON_SECRET>.
 * ?secret=... remains as a temporary deprecated fallback for manual debugging.
 */
export function authorizeCronRequest(
  req: Request,
  options: CronAuthOptions = {},
): CronAuthResult {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return { ok: false, deprecatedQueryAuth: false };
  }

  const authHeader = req.headers.get("authorization")?.trim() ?? "";
  if (authHeader === `Bearer ${secret}`) {
    return { ok: true, deprecatedQueryAuth: false };
  }

  if (options.allowDeprecatedQuerySecret) {
    const querySecret = new URL(req.url).searchParams.get("secret")?.trim() ?? "";
    if (querySecret === secret) {
      return { ok: true, deprecatedQueryAuth: true };
    }
  }

  return { ok: false, deprecatedQueryAuth: false };
}

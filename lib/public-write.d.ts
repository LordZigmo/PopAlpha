export type PublicWriteLogLevel = "info" | "warn" | "error";

export function hashPublicWriteValue(value: unknown): string | null;
export function getPublicWriteIp(req: Request): string;
export function getPublicWriteFetchSite(req: Request): string | null;
export function isCrossSitePublicWrite(req: Request): boolean;
export function retryAfterSeconds(retryAfterMs: number): number;
export function logPublicWriteEvent(
  level: PublicWriteLogLevel,
  payload: Record<string, unknown>,
): void;

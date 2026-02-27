export function buildPsaCertUrl(cert: string): string {
  return `https://www.psacard.com/cert/${encodeURIComponent(cert)}`;
}


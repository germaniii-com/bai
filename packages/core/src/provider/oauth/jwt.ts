/** Decode a JWT payload without verifying (expiry/claims only). */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) return undefined;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `exp` claim in epoch ms, or undefined when the token is not a readable JWT. */
export function jwtExpiryMs(token: string): number | undefined {
  const claims = decodeJwtClaims(token);
  const exp = claims?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

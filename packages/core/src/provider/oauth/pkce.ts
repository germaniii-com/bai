import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 PKCE pair (S256), base64url without padding. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Random OAuth `state` (CSRF token). */
export function randomState(): string {
  return base64url(randomBytes(32));
}

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

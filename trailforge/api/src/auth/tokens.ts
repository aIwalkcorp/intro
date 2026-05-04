import { SignJWT, jwtVerify } from "jose";
import { env } from "../lib/env";

const ISSUER = "trailforge";
const AUDIENCE = "trailforge-app";
const SECRET = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessClaims {
  sub: string;        // user id
  username: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ username: claims.username })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(SECRET);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== "string" || typeof payload.username !== "string") return null;
    return { sub: payload.sub, username: payload.username };
  } catch {
    return null;
  }
}

// Refresh token = opaque random string. We store its SHA-256 hash in the sessions table
// so a DB leak doesn't yield usable tokens. Rotation: every /auth/refresh issues a new
// refresh token and revokes the previous one.

export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashRefreshToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

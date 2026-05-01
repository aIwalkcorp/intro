import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessToken, type AccessClaims } from "./tokens";

declare module "hono" {
  interface ContextVariableMap {
    user: AccessClaims;
  }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authz = c.req.header("authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: "unauthenticated" }, 401);

  const claims = await verifyAccessToken(m[1]!);
  if (!claims) return c.json({ error: "invalid_token" }, 401);

  c.set("user", claims);
  await next();
};

export function getUser(c: Context): AccessClaims {
  return c.get("user");
}

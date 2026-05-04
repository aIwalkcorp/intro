import type { Context } from "hono";
import { db } from "../db/client";
import { auditLog } from "../db/schema";
import { log } from "./logger";

export interface AuditEntry {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(c: Context, entry: AuditEntry) {
  try {
    await db.insert(auditLog).values({
      userId: entry.userId ?? null,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata: entry.metadata ?? null,
      ipAddr: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    });
  } catch (e) {
    log.error("audit_write_failed", { action: entry.action, error: String(e) });
  }
}

export function clientIp(c: Context): string | null {
  const fwd = c.req.header("fly-client-ip")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip");
  return fwd ?? null;
}

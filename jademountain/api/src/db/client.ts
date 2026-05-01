import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env";
import * as schema from "./schema";

const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // pgbouncer / Neon pooler: transaction-mode pooling needs prepare:false
});

export const db = drizzle(client, { schema });
export const sqlClient = client;

export async function pingDb(): Promise<boolean> {
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  }
}

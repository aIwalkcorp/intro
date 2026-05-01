import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL or DATABASE_URL_UNPOOLED required");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

await migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log("[migrate] done");
await client.end();

// Temporary local preview for UI work. Backend stays on cloud (Fly).
// Run:  bun dev-server.ts
// Open: http://localhost:8765/trailforge/
//   (frontend defaults API to https://trailforge-api.fly.dev — no ?api= needed)

import { file } from "bun";
import { join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const PORT = 8765;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";

    // Hard deny: anything resembling a secret or the api source tree.
    if (/(^|\/)\.env(\.|$)/.test(path) || path.includes("/api/")) {
      return new Response("Forbidden", { status: 403 });
    }

    const abs = normalize(join(ROOT, path));
    if (!abs.startsWith(ROOT)) return new Response("Bad path", { status: 400 });

    const f = file(abs);
    if (!(await f.exists())) return new Response("Not found", { status: 404 });
    return new Response(f);
  },
});

console.log(`dev-server: http://localhost:${PORT}/trailforge/`);

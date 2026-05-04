import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = process.env.SKILL_DIR ?? join(import.meta.dir, "..", "..", "skill");

function readMaybe(rel: string): string {
  try { return readFileSync(join(SKILL_DIR, rel), "utf8"); }
  catch { return ""; }
}

function readExamples(): string {
  try {
    const dir = join(SKILL_DIR, "examples");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n\n");
  } catch { return ""; }
}

// Assemble once at module-load (process lifetime), per system-prompt.md.
export const SKILL_BUNDLE: string = [
  readMaybe("SKILL.md"),
  readMaybe("operations.md"),
  readMaybe("state-machine.md"),
  readExamples(),
].filter(Boolean).join("\n\n---\n\n");

if (!SKILL_BUNDLE.trim()) {
  console.warn(`[skill-bundle] empty bundle — SKILL_DIR=${SKILL_DIR}`);
}

// Bun.password defaults to argon2id (OWASP-recommended modern KDF).
// We pin the algorithm explicitly so a future Bun default change doesn't silently weaken hashes.

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

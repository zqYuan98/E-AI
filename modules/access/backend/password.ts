import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const MAX_PASSWORD_BYTES = 1024;
export const MAX_KDFS = 2;
// Fixed work factor: a stored value cannot ask scrypt for arbitrary memory or CPU.
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const ENCODED = /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const DUMMY = `scrypt-v1$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;
let active = 0;

export class PasswordBusy extends Error {}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES && [...value].length >= 12;
}

/** Same canonical username on creation and sign-in; passwords are never normalized. */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(name) ? name : null;
}

async function derive(password: string, salt: string): Promise<Buffer> {
  // No unbounded queue of expensive work, even across sign-in, creation and reset.
  if (active >= MAX_KDFS) throw new PasswordBusy();
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, "hex"), 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    active--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new Error("Invalid password length");
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

/** Unknown and disabled accounts do the same expensive comparison as an incorrect password. */
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!validPassword(password)) return false;
  const parsed = encoded?.match(ENCODED);
  const [, salt, wanted] = parsed ?? DUMMY.match(ENCODED)!;
  const given = await derive(password, salt!);
  const matches = timingSafeEqual(given, Buffer.from(wanted!, "hex"));
  return !!parsed && matches;
}

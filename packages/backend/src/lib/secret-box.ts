// Small secrets kept in the database (a model provider's API key): AES-256-GCM with a key derived from the
// deployment's SESSION_SECRET. A database copy or backup holds only ciphertext; the process that serves the
// admin and the workers share the secret, so each can read and write. Changing SESSION_SECRET makes stored
// values unreadable (open() returns null) and they must be entered again.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const key = (secret: string, purpose: string) => Buffer.from(hkdfSync("sha256", secret, "aihot-secret-box-v1", purpose, 32));

/** `v1.<iv>.<tag>.<ciphertext>` in base64url. `purpose` binds a value to its use (a copy in another column fails). */
export function seal(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The plain value, or null when the value is malformed, tampered with, bound to another purpose or sealed under another secret. */
export function open(sealed: string, secret: string, purpose: string): string | null {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(secret, purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

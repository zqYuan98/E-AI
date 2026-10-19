import { randomBytes } from "node:crypto";
import type { AccessPrincipal } from "@aihot/contracts/access";
import { MEMBER_COOKIE } from "@aihot/contracts/access";
import { parseCookies, sessionPrincipal, type AdminPrincipal } from "@aihot/backend/admin/auth";
import { audit } from "@aihot/backend/audit";
import { sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import type { CreateMember, Member } from "../types.ts";
import { hashPassword, normalizeUsername, validPassword, verifyPassword } from "./password.ts";

export const SESSION_SECONDS = 7 * 86400;

export class AccessError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface MemberRow {
  id: number;
  username: string;
  display_name: string;
  disabled: boolean;
  created_at: Date;
  updated_at: Date;
}
interface CredentialRow extends MemberRow {
  password_hash: string;
  credential_version: number;
}
const publicMember = (r: MemberRow): Member => ({
  id: r.id, username: r.username, name: r.display_name, disabled: r.disabled,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});
const invalid = () => new AccessError(400, "invalid_request", "用户名须为 3–64 位英文字母、数字或 ._-；密码至少 12 字符且不超过 1024 UTF-8 字节。");
const rejected = () => new AccessError(401, "unauthorized", "用户名或密码不正确。");

export function memberToken(header: string | undefined): string | null {
  const token = parseCookies(header)[MEMBER_COOKIE];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function realAdmin(header: string | undefined): Promise<AdminPrincipal | null> {
  const admin = await sessionPrincipal(header);
  return admin && !admin.dev && admin.userId !== null ? admin : null;
}

export async function memberPrincipal(header: string | undefined): Promise<AccessPrincipal | null> {
  const token = memberToken(header);
  if (!token) return null;
  const [row] = await sql<{ id: number; display_name: string; csrf_token: string }[]>`
    SELECT m.id, m.display_name, s.csrf_token FROM access_sessions s JOIN access_members m ON m.id = s.member_id
    WHERE s.id_hash = ${sha256(token)} AND s.expires_at > now() AND NOT m.disabled AND s.credential_version = m.credential_version`;
  return row ? { id: `member:${row.id}`, kind: "member", name: row.display_name, csrf: row.csrf_token } : null;
}

export async function accessPrincipal(header: string | undefined): Promise<AccessPrincipal | null> {
  const member = await memberPrincipal(header);
  if (member) return member;
  const admin = await realAdmin(header);
  return admin ? { id: `admin:${admin.userId!}`, kind: "admin", name: admin.name, csrf: admin.csrf } : null;
}

export async function listMembers(): Promise<Member[]> {
  const rows = await sql<MemberRow[]>`SELECT id, username, display_name, disabled, created_at, updated_at FROM access_members ORDER BY id`;
  return rows.map(publicMember);
}

export async function createMember(input: CreateMember, actor: string, requestId?: string): Promise<Member> {
  const username = normalizeUsername(input.username);
  if (!username || !validPassword(input.password)) throw invalid();
  const name = input.name === undefined ? username : input.name;
  if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw invalid();
  const encoded = await hashPassword(input.password);
  return sql.begin(async (tx) => {
    const [row] = await tx<MemberRow[]>`
      INSERT INTO access_members (username, display_name, password_hash) VALUES (${username}, ${name.trim()}, ${encoded})
      ON CONFLICT (username) DO NOTHING RETURNING id, username, display_name, disabled, created_at, updated_at`;
    if (!row) throw new AccessError(409, "conflict", "用户名已存在。");
    const member = publicMember(row);
    await audit(actor, "access.member.create", `member:${row.id}`, null, null, member, { db: tx, requestId });
    return member;
  }) as Promise<Member>;
}

export async function loginMember(username: unknown, password: unknown, requestId?: string): Promise<string> {
  if (!validPassword(password)) throw rejected();
  const name = normalizeUsername(username);
  const [snapshot] = name ? await sql<CredentialRow[]>`SELECT * FROM access_members WHERE username = ${name}` : [];
  const valid = await verifyPassword(password, snapshot && !snapshot.disabled ? snapshot.password_hash : null);
  if (!valid || !snapshot || snapshot.disabled) throw rejected();
  // Hashing happens without a database lock. Then serialize with reset/disable and recheck the exact
  // credential version: a login already verifying an old password cannot insert a session after reset.
  return sql.begin(async (tx) => {
    const [current] = await tx<CredentialRow[]>`SELECT * FROM access_members WHERE id = ${snapshot.id} FOR UPDATE`;
    if (!current || current.disabled || current.credential_version !== snapshot.credential_version || current.password_hash !== snapshot.password_hash) throw rejected();
    const token = randomBytes(32).toString("base64url");
    await tx`INSERT INTO access_sessions (id_hash, member_id, credential_version, csrf_token, expires_at)
      VALUES (${sha256(token)}, ${current.id}, ${current.credential_version}, ${randomBytes(24).toString("base64url")}, ${new Date(Date.now() + SESSION_SECONDS * 1000)})`;
    await audit(`member:${current.id}`, "access.login", `member:${current.id}`, null, null, null, { db: tx, requestId });
    return token;
  }) as Promise<string>;
}

export async function changeMember(id: number, change: { disable: true } | { enable: true } | { password: string }, actor: string, requestId?: string): Promise<Member> {
  if (!Number.isSafeInteger(id) || id < 1) throw new AccessError(400, "invalid_request", "成员编号无效。");
  if ("password" in change && !validPassword(change.password)) throw invalid();
  const encoded = "password" in change ? await hashPassword(change.password) : null;
  return sql.begin(async (tx) => {
    const [before] = await tx<MemberRow[]>`SELECT id, username, display_name, disabled, created_at, updated_at FROM access_members WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new AccessError(404, "not_found", "成员不存在。");
    const [row] = await tx<MemberRow[]>`
      UPDATE access_members SET password_hash = coalesce(${encoded}, password_hash), disabled = ${"disable" in change ? true : "enable" in change ? false : before.disabled},
        credential_version = credential_version + 1, updated_at = now() WHERE id = ${id}
      RETURNING id, username, display_name, disabled, created_at, updated_at`;
    await tx`DELETE FROM access_sessions WHERE member_id = ${id}`;
    const member = publicMember(row!);
    await audit(actor, encoded ? "access.member.reset" : "enable" in change ? "access.member.enable" : "access.member.disable", `member:${id}`, null, publicMember(before), member, { db: tx, requestId });
    return member;
  }) as Promise<Member>;
}

/**
 * A member changes their own password: the current one must match. Every session of the member ends, this one
 * too, so the next page asks to sign in with the new password.
 */
export async function changeOwnPassword(header: string | undefined, current: unknown, next: unknown, requestId?: string): Promise<void> {
  const principal = await memberPrincipal(header);
  if (!principal) throw new AccessError(401, "unauthorized", "Sign in first.");
  if (!validPassword(next)) throw new AccessError(400, "invalid_request", "新密码至少 12 个字符。");
  if (current === next) throw new AccessError(400, "invalid_request", "新密码不能和当前密码相同。");
  const id = Number(principal.id.slice("member:".length));
  const [row] = await sql<CredentialRow[]>`SELECT * FROM access_members WHERE id = ${id}`;
  if (!row || row.disabled || !validPassword(current) || !(await verifyPassword(current, row.password_hash))) {
    throw new AccessError(403, "forbidden", "当前密码不正确。");
  }
  await changeMember(id, { password: next as string }, `member:${id}`, requestId);
}

export async function logoutMember(header: string | undefined, requestId?: string): Promise<void> {
  const token = memberToken(header);
  if (!token) return;
  await sql.begin(async (tx) => {
    const [row] = await tx<{ member_id: number }[]>`DELETE FROM access_sessions WHERE id_hash = ${sha256(token)} RETURNING member_id`;
    if (row) await audit(`member:${row.member_id}`, "access.logout", `member:${row.member_id}`, null, null, null, { db: tx, requestId });
  });
}

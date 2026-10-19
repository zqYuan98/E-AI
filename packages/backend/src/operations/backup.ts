// A database dump and staged files are published together in a local snapshot directory. Modules can
// forbid ALL remote backup traffic; otherwise the existing daily/weekly/monthly S3 layout is retained.
// The dump and files are taken sequentially, not in a shared database/filesystem transaction.
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { constants, createReadStream, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { backupDirs, remoteBackupDenied } from "../modules.ts";
import { screenshotsForwarded } from "./feedback.ts";

const run = promisify(execFile);
const KEEP_LOCAL = 3;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

interface Store {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/** Whether the public framework has an object store. Internal sites can schedule local-only backups. */
export function backupConfigured(): boolean {
  return store() !== null;
}

function store(): Store | null {
  const get = (k: string) => process.env[k] || credential("integrations", k) || null;
  const secretId = get("DB_BACKUP_STORE_SECRET_ID");
  const secretKey = get("DB_BACKUP_STORE_SECRET_KEY");
  const bucket = get("DB_BACKUP_STORE_BUCKET");
  const region = get("DB_BACKUP_STORE_REGION");
  if (!secretId || !secretKey || !bucket || !region) return null;
  const domain = get("DB_BACKUP_STORE_DOMAIN");
  return { secretId, secretKey, bucket, region, endpoint: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : `https://${bucket}.cos.${region}.myqcloud.com` };
}

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4 headers for one S3 request. */
function signV4(opts: {
  method: string; url: URL; region: string; accessKey: string; secretKey: string; payloadHash: string; headers?: Record<string, string>;
}): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const service = "s3";
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.url.host, "x-amz-content-sha256": opts.payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalQuery = [...opts.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalPath = opts.url.pathname.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
  const canonical = [opts.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

function readable(info: BigIntStats, file: string) {
  if (info.isSymbolicLink()) throw new Error(`backup rejects symbolic link: ${file}`);
  if (!info.isDirectory() && !info.isFile()) throw new Error(`backup rejects special file: ${file}`);
  if (info.isFile() && info.nlink !== 1n) throw new Error(`backup rejects hard-linked file: ${file}`);
  // Even a privileged worker must not silently treat chmod 000 as a readable attachment.
  if (process.platform !== "win32" && ((info.mode & 0o444n) === 0n || (info.isDirectory() && (info.mode & 0o111n) === 0n))) {
    throw new Error(`backup path is not readable: ${file}`);
  }
}

function unchanged(before: BigIntStats, after: BigIntStats, file: string) {
  for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const) {
    if (before[key] !== after[key]) throw new Error(`backup path changed while being read: ${file}`);
  }
}

async function directory(file: string) {
  const info = await lstat(file, { bigint: true });
  readable(info, file);
  if (!info.isDirectory()) throw new Error(`backup path is not a directory: ${file}`);
  return info;
}

type OwnedPath = { file: string; info: BigIntStats };

// This error also tells the outer workspace cleanup to leave the tree alone. Otherwise it could
// recursively remove a replacement which the inner staging cleanup deliberately preserved.
class BackupIdentityError extends Error {}
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`;

async function ownedDirectory(file: string): Promise<OwnedPath> {
  const info = await directory(file);
  if (await realpath(file) !== path.resolve(file)) throw new BackupIdentityError(`backup rejects directory alias: ${file}`);
  return { file, info };
}

async function checkOwned(entries: readonly OwnedPath[]) {
  for (const { file, info } of entries) {
    const current = await lstat(file, { bigint: true }).catch((cause: unknown) => {
      throw new BackupIdentityError(`backup cleanup refused; cannot identify preserved path: ${file}`, { cause });
    });
    if (identity(info) !== identity(current) || current.isSymbolicLink() ||
        info.isDirectory() !== current.isDirectory() || info.isFile() !== current.isFile() ||
        (current.isFile() && current.nlink !== 1n) || await realpath(file) !== path.resolve(file)) {
      throw new BackupIdentityError(`backup cleanup refused; path identity/type changed, preserved: ${file}`);
    }
  }
}

async function cleanupOwned(parents: readonly OwnedPath[], entries: readonly OwnedPath[], failure?: unknown) {
  try {
    // Validate the whole set before deleting anything, and again immediately before each removal.
    await checkOwned([...parents, ...entries]);
    for (const entry of entries) {
      await checkOwned([...parents, entry]);
      await rm(entry.file, { recursive: entry.info.isDirectory() });
    }
  } catch (cause) {
    // Permission/IO errors must also prevent an outer recursive cleanup from erasing preserved files.
    throw new BackupIdentityError(`backup cleanup failed; temporary paths preserved: ${cause instanceof Error ? cause.message : cause}${failure ? `; original failure: ${String(failure)}` : ""}`,
      { cause: failure ? new AggregateError([failure, cause]) : cause });
  }
}

function relativeDirs(dirs: readonly string[]) {
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.split("/").every(part => /^\w[\w.-]*$/.test(part)) || dir.split("/")[0].toLowerCase() === "backups") {
      throw new Error(`backup folder must be a relative path outside backups/: ${dir}`);
    }
  }
  return [...new Set(dirs)];
}

/** Stage only regular files/directories, then pack that private tree, never the changing source tree.
 * lstat/realpath, no-follow file descriptors and before/after inode/metadata checks reject observed
 * links, aliases and changes. Node has no openat tree walk: this is NOT a sandbox against a hostile
 * same-UID process swapping ancestor directories between syscalls. The data/backup parents must be
 * controlled by the operator, not writable by untrusted local users.
 */
export async function createBackupArchive(dataDir: string, workspace: string, filename: string, dirs: readonly string[]) {
  const requested = relativeDirs(dirs);
  await directory(dataDir); // The configured data root itself must not be a symlink.
  const base = await realpath(dataDir);
  const baseInfo = await directory(base);
  const identities = new Map<string, string>([[`${baseInfo.dev}:${baseInfo.ino}`, base]]);
  // A bind/alias of the backup folder must not be recursively included as an attachment.
  const backupRoot = await lstat(path.join(base, "backups"), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (backupRoot) identities.set(`${backupRoot.dev}:${backupRoot.ino}`, "backups");
  const kept: string[] = [];
  const rootAncestors = new Map<string, Map<string, string>>();
  const missing: string[] = [];
  // Check every component, including a parent of a missing requested directory. A dangling link is
  // an error, not an absent optional directory; neither ENOTDIR nor EACCES is swallowed.
  for (const dir of requested) {
    let current = base;
    let absent = false;
    const ancestors = new Map<string, string>();
    for (const part of dir.split("/")) {
      current = path.join(current, part);
      const info = await lstat(current, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) { absent = true; break; }
      readable(info, current);
      if (!info.isDirectory()) throw new Error(`backup path is not a directory: ${current}`);
      const id = identity(info);
      if (identities.has(id) || ancestors.has(id)) throw new Error(`backup rejects directory alias: ${current} = ${identities.get(id) ?? ancestors.get(id)}`);
      if (await realpath(current) !== current) throw new Error(`backup rejects directory alias: ${current}`);
      if (current !== path.join(base, dir)) ancestors.set(id, current);
    }
    (absent ? missing : kept).push(dir);
    rootAncestors.set(dir, ancestors);
  }
  // A requested parent already contains its children. Do not archive the same subtree twice.
  const roots = kept.filter(dir => !kept.some(parent => dir.startsWith(`${parent}/`)));
  const parents = [await ownedDirectory(path.dirname(workspace)), await ownedDirectory(workspace)];
  const staged = await mkdtemp(path.join(workspace, ".files-"));
  const stagedOwner = await ownedDirectory(staged);
  const emptyList = `${staged}.list`;
  let listOwner: OwnedPath | undefined;
  let failure: unknown;
  try {
    const copy = async (relative: string, ancestors: Map<string, string>): Promise<void> => {
      const source = path.join(base, relative);
      const target = path.join(staged, relative);
      const before = await lstat(source, { bigint: true });
      readable(before, source);
      if (await realpath(source) !== source) throw new Error(`backup rejects path alias: ${source}`);
      if (before.isDirectory()) {
        const identity = `${before.dev}:${before.ino}`;
        if (identities.has(identity) || ancestors.has(identity)) throw new Error(`backup rejects directory alias: ${source} = ${identities.get(identity) ?? ancestors.get(identity)}`);
        identities.set(identity, source);
        await mkdir(target, { recursive: true, mode: 0o700 });
        const names = await readdir(source, { encoding: "buffer" });
        for (const raw of names) {
          const name = raw.toString("utf8");
          if (!Buffer.from(name).equals(raw) || /[\/\0]/.test(name) || name === "." || name === "..") {
            throw new Error(`backup rejects unrepresentable filename in ${source}`);
          }
          await copy(path.join(relative, name), ancestors);
        }
      } else {
        const input = await open(source, READ_FLAGS);
        try {
          unchanged(before, await input.stat({ bigint: true }), source);
          const output = await open(target, "wx", 0o600);
          try {
            // Bound the copy to the inspected size; a growing or replaced special file cannot hang it.
            const buffer = Buffer.alloc(64 * 1024);
            let remaining = before.size;
            while (remaining > 0n) {
              const { bytesRead } = await input.read(buffer, 0, Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length)), null);
              if (!bytesRead) throw new Error(`backup file truncated while being read: ${source}`);
              await output.writeFile(buffer.subarray(0, bytesRead));
              remaining -= BigInt(bytesRead);
            }
            unchanged(before, await input.stat({ bigint: true }), source);
          } finally { await output.close(); }
        } finally { await input.close(); }
      }
      unchanged(before, await lstat(source, { bigint: true }), source);
      if (await realpath(source) !== source) throw new Error(`backup path changed while being read: ${source}`);
    };
    for (const dir of roots) await copy(dir, rootAncestors.get(dir)!);
    unchanged(baseInfo, await lstat(base, { bigint: true }), base);
    // tar gets only the completed regular-file tree. Missing roots are recorded, not invented.
    const list = await open(emptyList, "wx", 0o600);
    try { listOwner = { file: emptyList, info: await list.stat({ bigint: true }) }; }
    finally { await list.close(); }
    await checkOwned([...parents, stagedOwner, listOwner]);
    const args = ["-czf", path.join(workspace, filename), "-C", staged, ...(roots.length ? ["--", ...roots] : ["-T", emptyList])];
    const pack = () => run("tar", args);
    let filesError: string | undefined;
    await pack().catch(() => pack()).catch((error: unknown) => {
      const stderr = (error as { stderr?: unknown })?.stderr;
      filesError = String(typeof stderr === "string" && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : error).slice(0, 300);
    });
    return { directories: roots, missingDirectories: missing, filesError };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupOwned(parents, [stagedOwner, ...(listOwner ? [listOwner] : [])], failure);
  }
}

export interface BackupFile {
  file: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: "paired-backup";
  version: 1;
  database: string;
  at: string;
  directories: string[];
  missingDirectories: string[];
  dump: BackupFile;
  archive: BackupFile;
}

async function fileInfo(file: string): Promise<BackupFile> {
  const before = await lstat(file, { bigint: true });
  readable(before, file);
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`backup invalid file: ${file}`);
  const handle = await open(file, READ_FLAGS);
  try {
    unchanged(before, await handle.stat({ bigint: true }), file);
    const h = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    unchanged(before, await handle.stat({ bigint: true }), file);
    unchanged(before, await lstat(file, { bigint: true }), file);
    return { file: path.basename(file), bytes: Number(before.size), sha256: h.digest("hex") };
  } finally { await handle.close(); }
}

/** Read gzip through EOF and inspect tar headers without extracting anything. Ordinary files and
 * directories, GNU long names and limited POSIX metadata are supported; links and special files are not.
 */
async function verifyArchive(file: string, roots: readonly string[]) {
  const before = await lstat(file, { bigint: true });
  readable(before, file);
  const handle = await open(file, READ_FLAGS);
  const source = handle.createReadStream({ autoClose: false });
  const unzip = createGunzip();
  source.on("error", error => unzip.destroy(error));
  const text = (bytes: Buffer) => {
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) throw new Error("backup archive has invalid UTF-8");
    return value;
  };
  const field = (header: Buffer, start: number, length: number) => text(header.subarray(start, start + length)).split("\0")[0]!;
  const octal = (header: Buffer, start: number, length: number) => {
    const value = field(header, start, length).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error("backup archive has invalid numeric header");
    const n = parseInt(value, 8);
    if (!Number.isSafeInteger(n)) throw new Error("backup archive member is too large");
    return n;
  };
  const header = Buffer.alloc(512);
  let filled = 0, remaining = 0, zeros = 0;
  let metadata = "", metadataSize = 0, parts: Buffer[] = [];
  let longName: string | undefined, pax: Record<string, string> | undefined;
  const members = new Map<string, string>();
  const finishMetadata = () => {
    const bytes = Buffer.concat(parts).subarray(0, metadataSize);
    if (metadata === "L") {
      if (longName !== undefined || pax || bytes.at(-1) !== 0) throw new Error("backup archive has invalid long name");
      longName = text(bytes.subarray(0, -1));
    } else {
      if (pax || longName !== undefined) throw new Error("backup archive has duplicate extended headers");
      pax = {};
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const lengthText = bytes.subarray(offset, space).toString("ascii");
        const length = Number(lengthText);
        if (space < offset || !/^\d+$/.test(lengthText) || !Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
          throw new Error("backup archive has invalid extended header");
        }
        const record = text(bytes.subarray(space + 1, offset + length - 1));
        const equal = record.indexOf("=");
        const key = record.slice(0, equal), value = record.slice(equal + 1);
        if (equal < 1 || !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "hdrcharset", "comment"].includes(key) || Object.hasOwn(pax, key) ||
            (key === "hdrcharset" && value !== "UTF-8")) throw new Error("backup archive has unsupported extended header");
        pax[key] = value;
        offset += length;
      }
    }
    metadata = "";
    parts = [];
  };
  try {
    unchanged(before, await handle.stat({ bigint: true }), file);
    for await (const chunk of source.pipe(unzip)) {
      const bytes = chunk as Buffer;
      let offset = 0;
      while (offset < bytes.length) {
        if (remaining) {
          const n = Math.min(remaining, bytes.length - offset);
          if (metadata) parts.push(bytes.subarray(offset, offset + n));
          remaining -= n;
          offset += n;
          if (!remaining && metadata) finishMetadata();
          continue;
        }
        const n = Math.min(512 - filled, bytes.length - offset);
        bytes.copy(header, filled, offset, offset + n);
        filled += n;
        offset += n;
        if (filled !== 512) continue;
        filled = 0;
        if (header.every(byte => byte === 0)) { zeros++; continue; }
        if (zeros) throw new Error("backup archive has data after end marker");
        let checksum = 0;
        for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
        if (octal(header, 148, 8) !== checksum) throw new Error("backup archive header checksum mismatch");
        let size = octal(header, 124, 12);
        const kind = String.fromCharCode(header[156]!);
        if (kind === "L" || kind === "x") {
          if (!size || size > 1024 * 1024) throw new Error("backup archive extended header is too large or empty");
          metadata = kind;
          metadataSize = size;
        } else {
          if (!["0", "\0", "5"].includes(kind)) throw new Error("backup archive rejects links and special members");
          if (pax?.size !== undefined) {
            if (!/^\d+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size))) throw new Error("backup archive has invalid member size");
            size = Number(pax.size);
          }
          const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
          let name = pax?.path ?? longName ?? `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
          if (kind === "5" && name.endsWith("/")) name = name.slice(0, -1);
          if (!name || /[\:\x00-\x1f\x7f]/.test(name) || name.split("/").some(part => !part || part === "." || part === "..") ||
              !roots.some(root => name === root || name.startsWith(`${root}/`))) throw new Error(`backup archive has unsafe member path: ${name}`);
          if (members.has(name)) throw new Error(`backup archive has duplicate member: ${name}`);
          if ((kind === "5" && size !== 0) || (octal(header, 100, 8) & 0o7000)) throw new Error("backup archive has unsafe member metadata");
          members.set(name, kind);
          pax = undefined;
          longName = undefined;
        }
        remaining = Math.ceil(size / 512) * 512;
      }
    }
    if (filled || remaining || zeros < 2 || metadata || pax || longName !== undefined) throw new Error("backup archive is truncated or lacks end markers");
    for (const root of roots) if (members.get(root) !== "5") throw new Error(`backup archive is missing directory: ${root}`);
    for (const name of members.keys()) {
      for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
        if (members.has(parent) && members.get(parent) !== "5") throw new Error(`backup archive has a non-directory parent: ${parent}`);
      }
    }
    unchanged(before, await handle.stat({ bigint: true }), file);
    unchanged(before, await lstat(file, { bigint: true }), file);
  } finally {
    source.destroy();
    unzip.destroy();
    await handle.close();
  }
}

/** Validate both published snapshots and the known database/stamp of this attempt's private workspace. */
async function verifyBackupContents(snapshot: string, database: string, stamp: string): Promise<BackupManifest> {
  await directory(snapshot);
  const names = [`${database}-${stamp}.dump`, `${database}-files-${stamp}.tar.gz`, "manifest.json"];
  if (JSON.stringify((await readdir(snapshot)).sort()) !== JSON.stringify([...names].sort())) throw new Error("backup snapshot has missing or unknown files");
  const manifestPath = path.join(snapshot, "manifest.json");
  const info = await lstat(manifestPath, { bigint: true });
  readable(info, manifestPath);
  if (!info.isFile() || info.size > 1024n * 1024n) throw new Error("invalid backup manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== "paired-backup" || manifest.version !== 1 || manifest.database !== database ||
      typeof manifest.at !== "string" || !Number.isFinite(Date.parse(manifest.at)) ||
      new Date(manifest.at).toISOString().slice(0, 16).replace(/[-:T]/g, "") !== stamp ||
      !Array.isArray(manifest.directories) || !Array.isArray(manifest.missingDirectories)) throw new Error("invalid backup manifest");
  relativeDirs(manifest.directories);
  relativeDirs(manifest.missingDirectories);
  for (const [index, entry] of [manifest.dump, manifest.archive].entries()) {
    if (!entry || entry.file !== names[index]) throw new Error("backup manifest filename mismatch");
    const actual = await fileInfo(path.join(snapshot, entry.file));
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) throw new Error(`backup checksum mismatch: ${entry.file}`);
  }
  await verifyArchive(path.join(snapshot, manifest.archive.file), manifest.directories);
  // A readable table of contents is not proof that a dump can be restored into a database.
  await run("pg_restore", ["--list", path.join(snapshot, manifest.dump.file)], { maxBuffer: 64 * 1024 * 1024 });
  return manifest;
}

/** Check manifest, hashes, gzip/tar safety and database TOC. This does NOT perform a database restore. */
export async function verifyLocalBackup(snapshot: string, database: string): Promise<BackupManifest> {
  const prefix = `${database}-snapshot-`;
  const suffix = path.basename(snapshot).slice(prefix.length);
  if (!path.basename(snapshot).startsWith(prefix) || !/^\d{12}-[a-zA-Z0-9]{6}$/.test(suffix)) throw new Error("not a managed backup snapshot");
  return verifyBackupContents(snapshot, database, suffix.slice(0, 12));
}

/** Only our verified, complete snapshot format is eligible. Legacy flat files, partial workspaces and
 * unknown/corrupt directories are left for the operator, never mistaken for restorable pairs/deleted.
 */
export async function pruneLocalBackups(dir: string, database: string, current: string) {
  const pairs: Array<{ folder: string; manifest: BackupManifest }> = [];
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith(`${database}-snapshot-`)) continue;
    const folder = path.join(dir, entry);
    try { pairs.push({ folder, manifest: await verifyLocalBackup(folder, database) }); }
    catch { continue; }
  }
  const others = pairs.filter(pair => pair.folder !== current).sort((a, b) => b.manifest.at.localeCompare(a.manifest.at) || b.folder.localeCompare(a.folder));
  for (const pair of others.slice(KEEP_LOCAL - 1)) {
    // Recheck immediately before deletion. Never recursively delete unexpected files in a snapshot.
    const manifest = await verifyLocalBackup(pair.folder, database);
    await rm(path.join(pair.folder, "manifest.json")); // Invalidate before removing either part.
    await rm(path.join(pair.folder, manifest.dump.file));
    await rm(path.join(pair.folder, manifest.archive.file));
    await rmdir(pair.folder);
  }
}

async function upload(s: Store, key: string, file: string, sha: string, size: number) {
  // Modules normally stay fixed after startup; still check before EACH request, not just once at import.
  if (remoteBackupDenied()) throw new Error("remote backup denied by an installed module");
  const url = new URL(`${s.endpoint}/${key}`);
  const headers = signV4({ method: "PUT", url, region: s.region, accessKey: s.secretId, secretKey: s.secretKey, payloadHash: sha, headers: { "content-length": String(size), "content-type": "application/octet-stream" } });
  const res = await fetch(url, { method: "PUT", headers, body: createReadStream(file) as never, duplex: "half", signal: AbortSignal.timeout(60 * 60_000) } as RequestInit);
  if (!res.ok) throw new Error(`backup upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function runBackup(now = new Date()) {
  const denied = remoteBackupDenied();
  const s = denied ? null : store(); // In deny mode even configured credentials are irrelevant.
  const dirs = [...(screenshotsForwarded() ? ["uploads"] : ["uploads", "feedback-screenshots"]), ...backupDirs()];
  await directory(config.dataDir);
  const base = await realpath(config.dataDir);
  const dir = path.join(base, "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parents = [await ownedDirectory(base), await ownedDirectory(dir)];
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // A unique private workspace prevents same-minute retries from overwriting a good local pair.
  const workspace = await mkdtemp(path.join(dir, `.pending-${name}-${stamp}-`));
  const workspaceOwner = await ownedDirectory(workspace);
  const snapshot = path.join(dir, `${name}-snapshot-${stamp}-${path.basename(workspace).slice(-6)}`);
  const dumpName = `${name}-${stamp}.dump`;
  const archiveName = `${name}-files-${stamp}.tar.gz`;
  let published = false;
  let failure: unknown;
  try {
    await run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--file", path.join(workspace, dumpName), config.databaseUrl], { maxBuffer: 16 * 1024 * 1024 });
    await checkOwned([...parents, workspaceOwner]);
    // TOC validation only. A real restore is tested separately against a disposable database.
    await run("pg_restore", ["--list", path.join(workspace, dumpName)], { maxBuffer: 64 * 1024 * 1024 });
    const { directories, missingDirectories, filesError } = await createBackupArchive(base, workspace, archiveName, dirs);
    const dump = await fileInfo(path.join(workspace, dumpName));
    const archive = filesError ? null : await fileInfo(path.join(workspace, archiveName));
    if (archive) {
      const manifest: BackupManifest = { format: "paired-backup", version: 1, database: name, at: now.toISOString(), directories, missingDirectories, dump, archive };
      await writeFile(path.join(workspace, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await verifyBackupContents(workspace, name, stamp);
      await checkOwned([...parents, workspaceOwner]);
      // Only a verified private workspace can acquire a final snapshot name.
      await rename(workspace, snapshot);
      published = true;
    }
    const out: Array<{ key: string; bytes: number; sha256: string }> = [];
    const summary = { at: now.toISOString(), local: published, uploaded: false, remoteDenied: denied,
      ...(published ? { manifest: `${path.basename(snapshot)}/manifest.json` } : {}), objects: out, ...(filesError ? { filesError } : {}),
      uploadError: undefined as string | undefined, retentionError: undefined as string | undefined };
    const record = () => sql`INSERT INTO settings (key, value, updated_by) VALUES ('backup.last', ${sql.json(summary as never)}, 'backup')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    const bj = new Date(now.getTime() + 8 * 3600_000);
    const prefixes = ["daily"];
    if (bj.getUTCDay() === 0) prefixes.push("weekly");
    if (bj.getUTCDate() === 1) prefixes.push("monthly");
    // Record local success before maintenance or remote IO; neither can unpublish this snapshot.
    await record();
    let uploadFailure: unknown, retentionFailure: unknown;
    try {
      for (const file of archive ? [dump, archive] : [dump]) {
        if (!s) {
          if (published) out.push({ key: `local-only:${file.file}`, bytes: file.bytes, sha256: file.sha256 });
          continue;
        }
        for (const prefix of prefixes) {
          const key = `${prefix}/${file.file}`;
          await upload(s, key, path.join(published ? snapshot : workspace, file.file), file.sha256, file.bytes);
          out.push({ key, bytes: file.bytes, sha256: file.sha256 });
        }
      }
      summary.uploaded = !!s && !filesError;
    } catch (error) {
      uploadFailure = error;
      summary.uploadError = String(error).slice(0, 300);
    }
    if (published) {
      try { await pruneLocalBackups(dir, name, snapshot); }
      catch (error) {
        retentionFailure = error;
        summary.retentionError = String(error).slice(0, 300);
      }
    }
    await record();
    if (uploadFailure && retentionFailure) throw new AggregateError([uploadFailure, retentionFailure], `backup upload and retention failed: ${summary.uploadError}; ${summary.retentionError}`);
    if (uploadFailure) throw uploadFailure;
    if (retentionFailure) throw new Error(`backup completed, but local retention failed: ${summary.retentionError}`, { cause: retentionFailure });
    if (filesError) throw new Error(`${denied ? "local backup incomplete" : "database backed up, but the file archive failed"}: ${filesError}`);
    return summary;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Failed attempts never acquire a final directory or a success manifest. Crash leftovers keep the
    // .pending prefix and are not counted as backups. Old flat-file backups are not touched.
    if (!published && !(failure instanceof BackupIdentityError)) await cleanupOwned(parents, [workspaceOwner], failure);
  }
}

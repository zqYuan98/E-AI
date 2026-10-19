// Standalone-only injection: no config.ts, dotenv, database driver or real subprocess is loaded.
// Execute the production source, not a copy of its logic; reject every unknown application import.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import * as modules from "../packages/backend/src/modules.ts";
import type * as Backup from "../packages/backend/src/operations/backup.ts";

let sequence = 0;
export async function isolated<T>(relative: string, imports: Record<string, unknown>): Promise<T> {
  const key = `__backupFixture${++sequence}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = imports;
  try {
    let source = stripTypeScriptTypes(await fs.readFile(new URL(relative, import.meta.url), "utf8"));
    source = source.replace(/^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/gm, (all, names: string, specifier: string) => {
      if (Object.hasOwn(imports, specifier)) return `const {${names.replace(/\bas\b/g, ":")}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}];`;
      if (specifier.startsWith("node:")) return all;
      throw new Error(`standalone refused unmocked import: ${specifier}`);
    });
    assert.doesNotMatch(source, /^import.*from\s+["'](?!node:)/m, "application imports must be explicitly injected");
    return await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// fixture ${sequence}`).toString("base64")}`) as T;
  } finally { delete globals[key]; }
}

export function tarEntry(name: string, content: Buffer = Buffer.alloc(0), kind = "0", mode = kind === "5" ? 0o700 : 0o600): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100, "use a long-name or PAX header for long fixture paths");
  const header = Buffer.alloc(512);
  header.write(name);
  const octal = (offset: number, width: number, value: number) => header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
  octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, content.length); octal(136, 12, 0);
  header.fill(32, 148, 156); header[156] = kind.charCodeAt(0);
  header.write("ustar\0", 257); header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
export const tarGzip = (entries: Buffer[], end = true) => gzipSync(Buffer.concat([...entries, ...(end ? [Buffer.alloc(1024)] : [])]));
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}
export const NOW = new Date("2026-11-01T04:00:00Z");
export const storeKeys = ["SECRET_ID", "SECRET_KEY", "BUCKET", "REGION", "DOMAIN"].map(key => `DB_BACKUP_STORE_${key}`);
export function syntheticStore(configured = true) {
  for (const key of storeKeys) {
    if (configured) process.env[key] = key.endsWith("DOMAIN") ? "backup.invalid" : "synthetic-only";
    else delete process.env[key];
  }
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_INTERNAL_ENABLED", "FEISHU_PUSH_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) process.env[key] = "false";
}

type Hook = (...args: any[]) => Promise<any>;
export async function fixture(options: { denied?: boolean; dirs?: string[]; configured?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "powerai-backup-standalone-"));
  const data = path.join(root, "data");
  await fs.mkdir(data);
  const config = { dataDir: data, databaseUrl: "postgres://synthetic@fixture.invalid/backup_test" };
  const state = {
    root, data, config, hooks: {} as Record<string, Hook>, records: [] as any[], fetched: [] as { key: string; bytes: Buffer }[],
    commands: [] as string[], execHook: undefined as undefined | ((cmd: string, args: string[]) => Promise<unknown>),
    credentialReads: 0, credentialFailure: false,
  };
  const previousModules = modules.serverModules();
  modules.installModules([{ name: "synthetic", backup: { ...(options.denied !== false ? { remote: "deny" as const } : {}), dirs: options.dirs ?? [] } }]);
  syntheticStore(options.configured !== false);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(url)).origin, "https://backup.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    state.fetched.push({ key: new URL(String(url)).pathname, bytes: Buffer.concat(chunks) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const execDefault = async (cmd: string, args: string[]) => {
    if (cmd === "pg_dump") await fs.writeFile(args[args.indexOf("--file") + 1]!, "PGDMP synthetic fixture; NOT a real database dump");
    else if (cmd === "pg_restore") {
      assert.equal(args[0], "--list", "a fake subprocess must never pretend to restore a database");
      assert.match(await fs.readFile(args[1]!, "utf8"), /^PGDMP synthetic fixture/);
    } else if (cmd === "tar") {
      assert.equal(args[0], "-czf");
      const staged = args[args.indexOf("-C") + 1]!;
      const roots = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
      const entries: Buffer[] = [];
      const add = async (relative: string) => {
        const file = path.join(staged, relative);
        if ((await fs.lstat(file)).isDirectory()) {
          entries.push(tarEntry(`${relative}/`, Buffer.alloc(0), "5"));
          for (const child of await fs.readdir(file)) await add(`${relative}/${child}`);
        } else entries.push(tarEntry(relative, await fs.readFile(file)));
      };
      for (const dir of roots) await add(dir);
      await fs.writeFile(args[1]!, tarGzip(entries));
    } else throw new Error(`real subprocess prohibited: ${cmd}`);
    return { stdout: "", stderr: "" };
  };
  function execFile() { throw new Error("real subprocess prohibited"); }
  Object.assign(execFile, { [promisify.custom]: async (cmd: string, args: string[]) => {
    state.commands.push(cmd);
    return state.execHook ? state.execHook(cmd, args) : execDefault(cmd, args);
  } });
  const sql = Object.assign(async (_strings: TemplateStringsArray, value: unknown) => { state.records.push(structuredClone(value)); return []; }, {
    options: { database: "backup_test" }, json: (value: unknown) => value,
  });
  const wrappedFs = Object.fromEntries(Object.entries(fs).map(([name, fn]) => [name, typeof fn === "function"
    ? (...args: unknown[]) => state.hooks[name] ? state.hooks[name]!(...args) : (fn as Hook)(...args) : fn]));
  const backup = await isolated<typeof Backup>("../packages/backend/src/operations/backup.ts", {
    "../config.ts": { config, credential: () => { state.credentialReads++; if (state.credentialFailure) throw new Error("fixture credentials must not be read"); return null; } },
    "../db.ts": { sql }, "../modules.ts": modules, "./feedback.ts": { screenshotsForwarded: () => false },
    "node:fs/promises": wrappedFs, "node:child_process": { execFile },
  });
  return Object.assign(state, { backup, modules, execDefault,
    save: async (relative: string, content: string | Buffer = "synthetic attachment") => {
      const file = path.join(data, relative);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file;
    },
    close: async () => { globalThis.fetch = previousFetch; modules.installModules(previousModules); await fs.rm(root, { recursive: true, force: true }); },
  });
}

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fixture, NOW, paxRecord, tarEntry, tarGzip } from "./backup-fixtures.ts";

const snapshots = async (data: string) => (await fs.readdir(path.join(data, "backups"))).filter(name => name.includes("-snapshot-"));
const snapshotPath = (data: string, manifest: string | undefined) => path.join(data, "backups", path.dirname(manifest!));

for (const configured of [true, false]) test(`deny creates a local pair with zero fetch and credential reads, configured=${configured}`, async t => {
  const f = await fixture({ dirs: ["research", "research"], configured }); t.after(f.close);
  f.credentialFailure = true;
  await f.save("uploads/document.txt"); await f.save("research/module.bin"); await f.save("feedback-screenshots/local.png");
  await f.save("imgcache/excluded.bin");
  const summary = await f.backup.runBackup(NOW);
  assert.equal(summary.local, true); assert.equal(summary.uploaded, false); assert.equal(summary.remoteDenied, true);
  assert.equal(f.fetched.length, 0); assert.equal(f.credentialReads, 0);
  const folder = snapshotPath(f.data, summary.manifest);
  const manifest = await f.backup.verifyLocalBackup(folder, "backup-test");
  assert.deepEqual(manifest.directories, ["uploads", "feedback-screenshots", "research"]);
  assert.deepEqual(manifest.missingDirectories, []);
  assert.equal((await fs.readdir(folder)).length, 3);
  assert.deepEqual(f.records.at(-1), summary);
});

test("no object store can still complete a locally requested backup", async t => {
  const f = await fixture({ denied: false, configured: false }); t.after(f.close);
  const summary = await f.backup.runBackup(NOW);
  assert.equal(summary.local, true); assert.equal(summary.uploaded, false); assert.equal(f.fetched.length, 0);
  const manifest = await f.backup.verifyLocalBackup(snapshotPath(f.data, summary.manifest), "backup-test");
  assert.deepEqual(manifest.missingDirectories, ["uploads", "feedback-screenshots"]);
});

test("EACCES is not missing and cannot reset the last success", async t => {
  const f = await fixture(); t.after(f.close);
  f.hooks.lstat = async (file, options) => {
    if (file === path.join(f.data, "uploads")) throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    return fs.lstat(file, options);
  };
  await assert.rejects(f.backup.runBackup(NOW), /synthetic EACCES/);
  assert.deepEqual(await fs.readdir(path.join(f.data, "backups")), []);
  assert.equal(f.records.length, 0); assert.equal(f.fetched.length, 0);
});

for (const kind of ["directory", "junction"]) test(`a replaced pending workspace is preserved, including ${kind} sentinel`, async t => {
  const f = await fixture(); t.after(f.close);
  let marker = "";
  f.execHook = async (cmd, args) => {
    assert.equal(cmd, "pg_dump");
    const workspace = path.dirname(args[args.indexOf("--file") + 1]!);
    await fs.rename(workspace, `${workspace}-original`);
    if (kind === "junction") {
      const target = path.join(f.root, "unrelated"); await fs.mkdir(target);
      await fs.symlink(target, workspace, "junction"); marker = path.join(target, "sentinel.txt");
    } else { await fs.mkdir(workspace); marker = path.join(workspace, "sentinel.txt"); }
    await fs.writeFile(marker, "must survive");
    throw new Error("synthetic dump failure after replacement");
  };
  await assert.rejects(f.backup.runBackup(NOW), /cleanup.*preserved/);
  assert.equal(await fs.readFile(marker, "utf8"), "must survive");
  assert.equal((await snapshots(f.data)).length, 0);
});

for (const target of ["stage", "list", "parent"]) test(`replacement of ${target} during tar cannot be removed by outer cleanup`, async t => {
  const f = await fixture(); t.after(f.close);
  await f.save("uploads/file.txt");
  let marker = "", replaced = false;
  f.execHook = async (cmd, args) => {
    if (cmd !== "tar") return f.execDefault(cmd, args);
    if (!replaced) {
      replaced = true;
      const stage = args[args.indexOf("-C") + 1]!;
      const original = target === "stage" ? stage : target === "list" ? `${stage}.list` : path.dirname(stage);
      await fs.rename(original, `${original}-original`);
      if (target === "list") { marker = original; await fs.writeFile(marker, "must survive"); }
      else { await fs.mkdir(original); marker = path.join(original, "sentinel.txt"); await fs.writeFile(marker, "must survive"); }
    }
    throw new Error("synthetic tar failure");
  };
  await assert.rejects(f.backup.runBackup(NOW), /cleanup.*preserved/);
  assert.equal(await fs.readFile(marker, "utf8"), "must survive");
  assert.equal((await snapshots(f.data)).length, 0); assert.equal(f.records.length, 0);
});

test("a replaced backup parent during pg_dump is preserved", async t => {
  const f = await fixture(); t.after(f.close);
  let marker = "";
  f.execHook = async (_cmd, args) => {
    const parent = path.dirname(path.dirname(args[args.indexOf("--file") + 1]!));
    await fs.rename(parent, `${parent}-original`); await fs.mkdir(parent);
    marker = path.join(parent, "sentinel.txt"); await fs.writeFile(marker, "must survive");
    throw new Error("synthetic parent replacement");
  };
  await assert.rejects(f.backup.runBackup(NOW), /cleanup.*preserved/);
  assert.equal(await fs.readFile(marker, "utf8"), "must survive");
});

for (const corruption of ["checksum", "not-tar", "toc"]) test(`invalid ${corruption} never acquires a published snapshot name`, async t => {
  const f = await fixture(); t.after(f.close);
  f.hooks.writeFile = async (file, content, options) => {
    await fs.writeFile(file, content, options);
    if (corruption === "checksum" && path.basename(file) === "manifest.json") {
      const manifest = JSON.parse(String(content));
      await fs.appendFile(path.join(path.dirname(file), manifest.archive.file), "corrupt");
    }
  };
  f.execHook = async (cmd, args) => {
    if (corruption === "not-tar" && cmd === "tar") { await fs.writeFile(args[1]!, "not even gzip"); return { stdout: "", stderr: "" }; }
    if (corruption === "toc" && cmd === "pg_restore") throw new Error("synthetic unreadable TOC");
    return f.execDefault(cmd, args);
  };
  await assert.rejects(f.backup.runBackup(NOW));
  assert.deepEqual(await fs.readdir(path.join(f.data, "backups")), []);
  assert.equal(f.records.length, 0); assert.equal(f.fetched.length, 0);
});

// Identity stubs model bind-alias observations; these are NOT real bind-mount tests.
for (const leaf of ["older", "missing"]) test(`a backup identity at an intermediate component rejects alias/${leaf} (lstat stub)`, async t => {
  const f = await fixture({ dirs: [`alias/${leaf}`] }); t.after(f.close);
  await f.save("backups/older/data.dump"); await f.save("alias/older/data.dump");
  const excluded = await fs.lstat(path.join(f.data, "backups"), { bigint: true });
  f.hooks.lstat = async (file, options) => file === path.join(f.data, "alias") ? excluded : fs.lstat(file, options);
  await assert.rejects(f.backup.runBackup(NOW), /directory alias/);
  assert.equal((await snapshots(f.data)).length, 0);
  assert.equal(f.commands.includes("tar"), false);
});

for (const alias of ["data", "ancestor"]) test(`a repeated ${alias} identity in path ancestors is rejected (lstat stub)`, async t => {
  const f = await fixture({ dirs: ["tree/a/missing"] }); t.after(f.close);
  await f.save("tree/a/file.txt");
  f.hooks.lstat = async (file, options) => file === path.join(f.data, "tree/a")
    ? fs.lstat(alias === "data" ? f.data : path.join(f.data, "tree"), options) : fs.lstat(file, options);
  await assert.rejects(f.backup.runBackup(NOW), /directory alias/);
});

test("ordinary shared parents and overlapping requested roots are not mistaken for aliases", async t => {
  const f = await fixture({ dirs: ["shared/a", "shared/b", "shared/a/child", "shared/absent"] }); t.after(f.close);
  await f.save("shared/a/child/file.txt"); await f.save("shared/b/file.txt");
  const summary = await f.backup.runBackup(NOW);
  const manifest = await f.backup.verifyLocalBackup(snapshotPath(f.data, summary.manifest), "backup-test");
  assert.deepEqual(manifest.directories, ["shared/a", "shared/b"]);
  assert.deepEqual(manifest.missingDirectories, ["uploads", "feedback-screenshots", "shared/absent"]);
});

test("retention keeps three verified directories and leaves flat and unknown files unchanged", async t => {
  const f = await fixture(); t.after(f.close);
  await f.save("uploads/kept.txt");
  const legacy = await f.save("backups/backup-test-202610010400.dump", "legacy dump");
  const flatArchive = await f.save("backups/backup-test-files-202610010400.tar.gz", "legacy archive");
  const unknown = await f.save("backups/backup-test-snapshot-202609010400-ABCDEF/keep.txt", "unknown");
  for (const day of [1, 2, 3, 4]) await f.backup.runBackup(new Date(`2026-11-0${day}T04:00:00Z`));
  const names = (await snapshots(f.data)).filter(name => !name.endsWith("ABCDEF"));
  assert.equal(names.length, 3);
  const days: number[] = [];
  for (const name of names) {
    const manifest = await f.backup.verifyLocalBackup(path.join(f.data, "backups", name), "backup-test");
    days.push(new Date(manifest.at).getUTCDate());
    assert.equal((await fs.readdir(path.join(f.data, "backups", name))).length, 3);
  }
  assert.deepEqual(days.sort(), [2, 3, 4]);
  assert.equal(await fs.readFile(legacy, "utf8"), "legacy dump");
  assert.equal(await fs.readFile(flatArchive, "utf8"), "legacy archive");
  assert.equal(await fs.readFile(unknown, "utf8"), "unknown");
  assert.equal(await fs.readFile(path.join(f.data, "uploads/kept.txt"), "utf8"), "synthetic attachment");
});

for (const denied of [false, true]) test(`retention failure preserves and records the new local success; deny=${denied}`, async t => {
  const f = await fixture({ denied }); t.after(f.close);
  for (const day of [1, 2, 3]) await f.backup.runBackup(new Date(`2026-11-0${day}T04:00:00Z`));
  f.fetched.length = 0; f.records.length = 0;
  f.hooks.rm = async (file, options) => {
    if (path.basename(file) === "manifest.json") throw Object.assign(new Error("synthetic retention EACCES"), { code: "EACCES" });
    return fs.rm(file, options);
  };
  await assert.rejects(f.backup.runBackup(new Date("2026-11-04T04:00:00Z")), /backup completed.*retention.*EACCES/);
  assert.equal(f.fetched.length, denied ? 0 : 2);
  const record = f.records.at(-1);
  assert.equal(record.local, true); assert.equal(record.uploaded, !denied); assert.match(record.retentionError, /EACCES/);
  assert.equal((await snapshots(f.data)).length, 4);
  await f.backup.verifyLocalBackup(snapshotPath(f.data, record.manifest), "backup-test");
});

test("persistent tar failure in deny mode neither publishes nor uploads an incomplete pair", async t => {
  const f = await fixture(); t.after(f.close);
  f.execHook = async (cmd, args) => {
    if (cmd === "tar") throw Object.assign(new Error("command failed"), { stderr: "synthetic packing failure" });
    return f.execDefault(cmd, args);
  };
  await assert.rejects(f.backup.runBackup(NOW), /local backup incomplete: synthetic packing failure/);
  assert.equal(f.commands.filter(cmd => cmd === "tar").length, 2);
  assert.equal(f.fetched.length, 0); assert.equal(f.records.at(-1).local, false);
  assert.equal(f.records.at(-1).uploaded, false); assert.deepEqual(await snapshots(f.data), []);
});

test("links and unreadable source metadata fail explicitly rather than becoming missing directories", async t => {
  const f = await fixture(); t.after(f.close);
  await f.save("actual/item.txt");
  await fs.symlink(path.join(f.data, "actual"), path.join(f.data, "uploads"), "junction");
  await assert.rejects(f.backup.runBackup(NOW), /symbolic link/);
  assert.equal(f.records.length, 0);
});

test("hard-linked source files are not archived", async t => {
  const f = await fixture(); t.after(f.close);
  const original = await f.save("uploads/original.txt");
  await fs.link(original, path.join(f.data, "uploads/alias.txt"));
  await assert.rejects(f.backup.runBackup(NOW), /hard-linked/);
});

test("deny is rechecked before every upload, not just before the dump", async t => {
  const f = await fixture({ denied: false }); t.after(f.close);
  const upload = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await upload(...args);
    f.modules.installModules([{ name: "newly-private", backup: { remote: "deny" } }]);
    return response;
  }) as typeof fetch;
  await assert.rejects(f.backup.runBackup(NOW), /remote backup denied/);
  assert.equal(f.fetched.length, 1); assert.equal(f.records.at(-1).local, true);
  assert.equal(f.records.at(-1).uploaded, false); assert.match(f.records.at(-1).uploadError, /denied/);
});

const uploadRoot = tarEntry("uploads/", Buffer.alloc(0), "5");
const unsafeArchives: Array<[string, Buffer]> = [
  ["non-tar gzip", gzipSync(Buffer.from("not a tar stream"))],
  ["no gzip", Buffer.from("not gzip")],
  ["missing tar terminator", tarGzip([uploadRoot], false)],
  ["truncated body", gzipSync(tarEntry("uploads/file", Buffer.alloc(1024)).subarray(0, 600))],
  ["unknown manifest root", tarGzip([tarEntry("other/", Buffer.alloc(0), "5")])],
  ["duplicate member", tarGzip([uploadRoot, uploadRoot])],
  ["non-directory parent", tarGzip([uploadRoot, tarEntry("uploads/file"), tarEntry("uploads/file/child")])],
  ["setuid member", tarGzip([uploadRoot, tarEntry("uploads/file", Buffer.alloc(0), "0", 0o4600)])],
  ["pax escaping name", tarGzip([uploadRoot, tarEntry("PaxHeader", paxRecord("path", "../escape"), "x"), tarEntry("uploads/file")])],
  ["pax sparse extension", tarGzip([uploadRoot, tarEntry("PaxHeader", paxRecord("GNU.sparse.name", "uploads/file"), "x"), tarEntry("uploads/file")])],
  ["gnu escaping long name", tarGzip([uploadRoot, tarEntry("././@LongLink", Buffer.from("/escape\0"), "L"), tarEntry("uploads/file")])],
];
for (const name of ["../escape", "/escape", "uploads/../../escape", "uploads/./file", "uploads//file", "C:/escape", "uploads/a\b", "uploads/a:stream", "uploads/a\nfile"]) {
  unsafeArchives.push([`unsafe path ${JSON.stringify(name)}`, tarGzip([uploadRoot, tarEntry(name)])]);
}
for (const kind of ["1", "2", "3", "4", "6", "g", "S"]) unsafeArchives.push([`special type ${kind}`, tarGzip([uploadRoot, tarEntry("uploads/member", Buffer.alloc(0), kind)])]);
const badHeader = tarEntry("uploads/file"); badHeader[0] = 0x7a;
unsafeArchives.push(["header checksum", tarGzip([uploadRoot, badHeader])]);
const badCrc = tarGzip([uploadRoot]); badCrc[badCrc.length - 8] ^= 0xff;
unsafeArchives.push(["gzip checksum", badCrc]);

for (const [label, bytes] of unsafeArchives) test(`matching manifest hashes still reject ${label}`, async t => {
  const f = await fixture(); t.after(f.close);
  await f.save("uploads/file");
  const summary = await f.backup.runBackup(NOW);
  const folder = snapshotPath(f.data, summary.manifest);
  const manifestFile = path.join(folder, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(path.join(folder, manifest.archive.file), bytes);
  manifest.archive.bytes = bytes.length;
  manifest.archive.sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.backup.verifyLocalBackup(folder, "backup-test"));
});

for (const format of ["pax", "gnu"]) test(`safe ${format} long UTF-8 member names pass structural verification`, async t => {
  const f = await fixture(); t.after(f.close);
  await f.save("uploads/file");
  const name = `uploads/${"a".repeat(110)}/附件.txt`;
  f.execHook = async (cmd, args) => {
    if (cmd !== "tar") return f.execDefault(cmd, args);
    const metadata = format === "pax" ? tarEntry("PaxHeader", paxRecord("path", name), "x") : tarEntry("././@LongLink", Buffer.from(`${name}\0`), "L");
    await fs.writeFile(args[1]!, tarGzip([uploadRoot, metadata, tarEntry("uploads/placeholder", Buffer.from("synthetic"))]));
    return { stdout: "", stderr: "" };
  };
  assert.equal((await f.backup.runBackup(NOW)).local, true);
});

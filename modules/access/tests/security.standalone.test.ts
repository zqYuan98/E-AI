import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { originAllowed, safeReturnPath, siteAccess } from "@aihot/contracts/access";
import { migrationPlan } from "../../../scripts/migration-safety.ts";
import { access } from "../module.ts";
import { LoginLimits } from "../backend/limits.ts";
import { MAX_KDFS, PasswordBusy, hashPassword, normalizeUsername, validPassword, verifyPassword } from "../backend/password.ts";

test("usernames have one canonical ASCII spelling and passwords have a UTF-8 byte ceiling", () => {
  assert.equal(normalizeUsername("  Alice.Test-01  "), "alice.test-01");
  for (const name of [null, {}, "ab", "alice/user", "Ａlice", "user\nname", "a".repeat(65)]) assert.equal(normalizeUsername(name), null);
  assert.equal(validPassword("口".repeat(341)), true);
  assert.equal(validPassword("口".repeat(342)), false);
  assert.equal(validPassword("x".repeat(1024)), true);
  assert.equal(validPassword("x".repeat(1025)), false);
  assert.equal(validPassword("short"), false);
});

test("asynchronous scrypt uses independent salts, bounded parallelism and a dummy comparison", async () => {
  const password = "test-only password 123";
  const pending = Array.from({ length: MAX_KDFS }, () => hashPassword(password));
  await assert.rejects(hashPassword(password), PasswordBusy);
  const [one, two] = await Promise.all(pending);
  assert.notEqual(one, two);
  assert.match(one!, /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword(password, one!), true);
  assert.equal(await verifyPassword(`${password}wrong`, one!), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, "scrypt-v1$malformed"), false);
  assert.equal(await verifyPassword("x".repeat(1025), one!), false);
  await assert.rejects(hashPassword("short"));
  assert.equal(await verifyPassword(password, two!), true, "all slots were released");
});

test("login attempts are capped per visitor and globally without an unbounded address map", () => {
  const limits = new LoginLimits();
  for (let i = 0; i < 10; i++) assert.equal(limits.allow("one", 100), true);
  for (let i = 0; i < 500; i++) assert.equal(limits.allow("one", 100), false, "one visitor alone cannot use up everyone's budget");
  for (let i = 0; i < 190; i++) assert.equal(limits.allow(`other-${i % 19}`, 100), i < 190);
  assert.equal(limits.allow("new-address", 100), false);
  assert.equal(limits.allow("another-address", 200), false);
  assert.equal(limits.allow("one", 900_100), true);
});

test("successful sign-ins give their attempt back, so a shared office address is not locked out", () => {
  const limits = new LoginLimits();
  for (let i = 0; i < 50; i++) {
    assert.equal(limits.allow("office", 100), true);
    limits.forgive("office");
  }
  for (let i = 0; i < 10; i++) assert.equal(limits.allow("office", 100), true);
  assert.equal(limits.allow("office", 100), false, "failures still count");
  limits.forgive("unknown-address");
  assert.equal(limits.allow("office", 100), false);
});

test("module paths and redirects follow the shared access contract", () => {
  assert.deepEqual(siteAccess([access]), { loginPath: "/login", sessionPath: "/api/access/session" });
  assert.deepEqual(access.adminPages, [{ path: "admin/access", file: "web/admin.tsx" }]);
  assert.equal(safeReturnPath("/policy?q=test", access.access!), "/policy?q=test");
  for (const target of ["//evil.invalid", "/" + String.fromCharCode(92) + "evil.invalid", "/api/v1/items", "/policy.data", "/LOGIN/", "/\t/evil.invalid"]) {
    assert.equal(safeReturnPath(target, access.access!), "/");
  }
  assert.equal(safeReturnPath("https://evil.invalid/policy", access.access!), "/policy");
  assert.equal(originAllowed("https://inside.invalid", ["https://inside.invalid"]), true);
  for (const origin of [undefined, "null", "https://outside.invalid", "http://inside.invalid"]) assert.equal(originAllowed(origin, ["https://inside.invalid"]), false);
});

test("new access migrations each contain one online-safe statement", () => {
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir)) {
    assert.match(file, /^011[0-3]_.*\.sql$/);
    const plan = migrationPlan(readFileSync(new URL(file, dir), "utf8"));
    assert.ok(plan);
  }
});

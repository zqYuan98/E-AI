// Access decisions shared by SSR and the API: no network or database is needed to validate their boundaries.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loginLocation, originAllowed, pageGuard, pageTarget, safeReturnPath, siteAccess } from "@aihot/contracts/access";
import { backupDirs, installModules, remoteBackupDenied, serverModules } from "@aihot/backend/modules";

const access = { loginPath: "/login", sessionPath: "/api/access/session" };
const original = serverModules();
after(() => installModules(original));

test("public is the absence of an access module, not a conflicting or malformed declaration", () => {
  assert.equal(siteAccess([]), null);
  assert.equal(siteAccess([{ name: "access", access }]), access);
  assert.throws(() => siteAccess([{ name: "one", access }, { name: "two", access }]));
  for (const loginPath of ["//evil.invalid", "/api/login", "/admin/login", "/login?next=bad", "/login#x"]) {
    assert.throws(() => siteAccess([{ name: "access", access: { ...access, loginPath } }]));
  }
  assert.throws(() => siteAccess([{ name: "access", access: { ...access, sessionPath: "https://evil.invalid/api/session" } }]));
});

test("unknown pages and encoded variants are protected, with only the exact login page open", () => {
  for (const target of ["/login", "/LOGIN/", "/%6cogin", "/login.data?_routes=access"]) {
    const parsed = pageTarget(target)!;
    assert.equal(pageGuard(access, parsed.path), "open", target);
  }
  for (const target of ["/", "/_.data", "/policy.data", "/login-extra", "/login/secret", "/login%2fsecret", "/arbitrary", "/login/../policy"]) {
    const parsed = pageTarget(target)!;
    assert.equal(pageGuard(access, parsed.path), "session", target);
  }
  for (const target of ["/admin", "/admin/login", "/ADMIN/access.data"]) {
    assert.equal(pageGuard(access, pageTarget(target)!.path), "admin", target);
  }
  for (const target of ["https://evil.invalid", "not-a-path", "/%", "/%C0%AF"]) assert.equal(pageTarget(target), null, target);
});

test("data navigation returns to the page without router-only query parameters", () => {
  assert.deepEqual(pageTarget("/policy.data?q=%E7%94%B5%E7%BD%91&_routes=policy&level=csg"), {
    path: "/policy", href: "/policy?q=%E7%94%B5%E7%BD%91&level=csg", data: true,
  });
  assert.deepEqual(pageTarget("/_.data?_routes=root"), { path: "/", href: "/", data: true });
  assert.equal(pageTarget("/items/a%2fb")!.path, "/items/a%2Fb");
});

test("a return target can never become a different-origin Location or an API/data endpoint", () => {
  for (const target of [undefined, {}, "//evil.invalid", "/" + String.fromCharCode(92) + "evil.invalid", "javascript:alert(1)", "/\r\nLocation: https://evil.invalid", "/api", "/api/private", "/%61pi/access/session", "/policy.data", "/login", "/LOGIN/", "/" + "x".repeat(2048)]) {
    assert.equal(safeReturnPath(target, access), "/", String(target));
  }
  assert.equal(safeReturnPath("/policy?q=grid", access), "/policy?q=grid");
  assert.equal(safeReturnPath("https://evil.invalid/policy?q=grid", access), "/policy?q=grid");
  assert.equal(loginLocation(access, "/"), "/login");
  assert.equal(loginLocation(access, "/policy?level=csg"), "/login?returnTo=%2Fpolicy%3Flevel%3Dcsg");
});

test("Origin must be present and exactly same-origin, never a suffix or an opaque origin", () => {
  const origins = ["https://internal.example", "http://127.0.0.1:18100"];
  for (const origin of [undefined, "", "null", "https://internal.example.evil.invalid", "http://internal.example", "https://internal.example:444", "http://127.0.0.1:18101"]) {
    assert.equal(originAllowed(origin, origins), false, String(origin));
  }
  assert.equal(originAllowed("https://internal.example", origins), true);
  assert.equal(originAllowed("http://127.0.0.1:18100", origins), true);
});

test("any module can deny remote backup, regardless of registration order", () => {
  installModules([]);
  assert.equal(remoteBackupDenied(), false);
  for (const modules of [
    [{ name: "public" }, { name: "access", backup: { remote: "deny" as const } }],
    [{ name: "access", backup: { remote: "deny" as const } }, { name: "public" }],
  ]) {
    installModules(modules);
    assert.equal(remoteBackupDenied(), true);
  }
});

test("backup paths are relative, outside backups and deduplicated without accepting traversal", () => {
  installModules([{ name: "one", backup: { dirs: ["private/research", "uploads"] } }, { name: "two", backup: { dirs: ["private/research"] } }]);
  assert.deepEqual(backupDirs(), ["private/research", "uploads"]);
  for (const dir of ["", "/private", "C:/private", "../private", "private/../uploads", "private//research", "private/./research", "private" + String.fromCharCode(92) + "research", "backups", "BACKUPS/nested", "private\0research"]) {
    installModules([{ name: "fixture", backup: { dirs: [dir] } }]);
    assert.throws(() => backupDirs(), /relative path/, dir);
  }
});

// A secret kept in the database is ciphertext, bound to the deployment's secret and to its purpose.
import assert from "node:assert/strict";
import { test } from "node:test";
import { open, seal } from "../packages/backend/src/lib/secret-box.ts";

const SECRET = "test-session-secret-0123456789";

test("a sealed value opens only with the same secret and purpose", () => {
  const sealed = seal("sk-live-0123456789abcdef", SECRET, "model-provider:a");
  assert.ok(!sealed.includes("sk-live"));
  assert.equal(open(sealed, SECRET, "model-provider:a"), "sk-live-0123456789abcdef");
  assert.equal(open(sealed, "another-session-secret-9876543210", "model-provider:a"), null, "a rotated SESSION_SECRET");
  assert.equal(open(sealed, SECRET, "model-provider:b"), null, "a value copied to another provider");
});

test("every seal is different, and a changed or malformed value never opens", () => {
  assert.notEqual(seal("x", SECRET, "p"), seal("x", SECRET, "p"));
  const [v, iv, tag, data] = seal("sk-abc-123456789", SECRET, "p").split(".");
  const flipped = (data!.startsWith("A") ? "B" : "A") + data!.slice(1);
  assert.equal(open([v, iv, tag, flipped].join("."), SECRET, "p"), null);
  for (const bad of ["", "v1", "v1..", "v2.a.b.c", "not-a-sealed-value", `${v}.${iv}.${tag}`]) assert.equal(open(bad, SECRET, "p"), null);
});

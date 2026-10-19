import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { ACCESS } from "../app/lib/access.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

assert.equal(ACCESS, null, "Run with the access module removed in the isolated public-site fixture");
const api = createServer((_req, res) => { res.writeHead(404); res.end(); });
let web: WebServer;
before(async () => { web = await startWebServer(api); });
after(async () => { await web?.stop(); });
test("uninstalled access preserves anonymous immutable caching of emitted browser assets", async () => {
  const files = JSON.parse(await readFile(new URL("../build/client/.access-assets.json", import.meta.url), "utf8")) as string[];
  assert.ok(files.length > 10);
  for (const asset of files) {
    const response = await fetch(web.origin + asset, { method: "HEAD", redirect: "manual" });
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable", asset);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

// 浏览器报来的访问：只收站内页面的路径，查询参数、后台和接口不收；每个成员每分钟有上限。
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowVisit, deviceOf, parseVisit } from "../backend/visit.ts";

test("only a page path is kept: no query, no admin, api or login pages, no other fields", () => {
  assert.deepEqual(parseVisit({ path: "/story/abc-123", title: "  事件一  " }), { path: "/story/abc-123", title: "事件一" });
  assert.deepEqual(parseVisit({ path: "/" }), { path: "/", title: "" });
  assert.deepEqual(parseVisit({ path: "/research/2", title: "a\u0000b" }), { path: "/research/2", title: "a b" });
  for (const path of ["/all?q=secret", "/all#top", "/a b", "story/1", "/admin", "/admin/usage", "/api/site/visit", "/login", "/LOGIN?returnTo=/", `/${"x".repeat(200)}`]) {
    assert.equal(parseVisit({ path }), null, path);
  }
  assert.equal(parseVisit({ path: "/about", extra: 1 }), null);
  assert.equal(parseVisit({ path: 3 }), null);
  assert.equal(parseVisit(null), null);
  assert.equal(parseVisit({ path: "/about", title: "长".repeat(400) }), null, "a title far past the limit is refused");
  assert.equal(parseVisit({ path: "/about", title: "长".repeat(300) })!.title.length, 120, "a long title is cut");
});

test("phones and tablets are told from computers by the user agent", () => {
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), "mobile");
  assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36"), "mobile");
  assert.equal(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"), "desktop");
  assert.equal(deviceOf(undefined), "desktop");
});

test("a member is limited to 60 visits a minute and the others are not affected", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) assert.equal(allowVisit(7001, t0 + i), true, `visit ${i + 1}`);
  assert.equal(allowVisit(7001, t0 + 100), false, "the 61st within the minute");
  assert.equal(allowVisit(7002, t0 + 100), true, "another member has a budget of its own");
  assert.equal(allowVisit(7001, t0 + 60_001), true, "the minute is over");
});

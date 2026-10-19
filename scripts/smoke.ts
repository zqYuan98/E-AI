// Whole-site deploy/CI check. Mode comes from installed declarations, never from a received 401.
// node scripts/smoke.ts --base http://localhost:3000 [--anonymous-only]
// Release gate: add --require-auth --cookie-stdin (one Cookie header value), or --cookie-fd 3.
// Without credentials an internal run explicitly reports authentication untested.
import { createReadStream } from "node:fs";
import { SITE } from "@aihot/site";
import { MODULES } from "@aihot/site/modules";
import { loginLocation, pageGuard, siteAccess, type ModuleAccess } from "@aihot/contracts/access";
import type { ModuleDeclaration } from "@aihot/contracts/modules";
import { CheckInputError, checkArgs, handshakeProblem, loginAssets, MCP_INITIALIZE, pageProblem, redirectProblem, sessionCookie, statusProblem, validPrincipal } from "./lib/outlet-checks.ts";

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/api/v1/agent", /markdown/],
  ["/api/v1/agent/latest", /markdown/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/feed/full.xml", /xml/],
  ["/feed/daily.xml", /xml/],
  ["/feed/weekly.xml", /xml/],
  ["/feed/monthly.xml", /xml/],
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
const OPEN_MACHINE = new Set(["/api/health", "/icon.png", "/favicon.ico"]);

export interface SmokeOptions {
  base: string;
  access: ModuleAccess | null;
  site: Pick<typeof SITE, "name" | "mcpPrefix">;
  modules?: readonly ModuleDeclaration[];
  cookie?: string | null;
  requireAuth?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
}
export interface SmokeResult {
  failed: number;
  auth: "not-required" | "not-run" | "passed" | "failed";
}

/** Only the requested descriptor is read: no dotenv, cookie files, environment secrets or login calls. */
export async function readSessionCookie(fd: number | null, timeoutMs = 30_000): Promise<string | null> {
  if (fd === null) return null;
  const stream = fd === 0 ? process.stdin : createReadStream("", { fd, autoClose: false, highWaterMark: 1024 });
  const timer = setTimeout(() => stream.destroy(new Error("session input timeout")), timeoutMs);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 8192) throw new Error("session input too large");
      chunks.push(bytes);
    }
    return sessionCookie(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new CheckInputError("无法读取有效会话 Cookie（输入无效、过长或超时）"); }
  finally { clearTimeout(timer); stream.destroy(); }
}

async function boundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("check response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Shared internal branch for mcp-check; no backend module or SDK transport is initialized. */
export async function runInternalMcpChecks(options: SmokeOptions & { access: ModuleAccess }): Promise<SmokeResult> {
  return runChecks(options, true);
}
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  return runChecks(options, false);
}

async function runChecks(options: SmokeOptions, mcpOnly: boolean): Promise<SmokeResult> {
  const { access, site } = options;
  // Validate before sending anything, including when called directly by tests/tools.
  const { base } = checkArgs(["--base", options.base], "smoke");
  const cookie = options.cookie ? sessionCookie(options.cookie) : null;
  if (!access && (cookie || options.requireAuth)) throw new CheckInputError("公开站没有内部会话验收；不会发送 Cookie");
  const log = options.log ?? console.log;
  const result: SmokeResult = { failed: 0, auth: access ? "not-run" : "not-required" };
  const timeoutMs = options.timeoutMs ?? 30_000;
  type Expect = (res: Response, body: string) => string | null;
  async function check(label: string, path: string, expect: Expect, { authenticated = false, method = "GET", text = false }: { authenticated?: boolean; method?: string; text?: boolean } = {}) {
    let res: Response | undefined;
    let problem: string | null;
    try {
      const target = new URL(path, base);
      if (target.origin !== base || target.username || target.password) throw new Error("foreign target");
      const headers = new Headers();
      if (authenticated && cookie) headers.set("cookie", cookie);
      if (method === "POST") {
        headers.set("content-type", "application/json");
        headers.set("accept", "application/json, text/event-stream");
      }
      res = await fetch(target, {
        method, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        ...(method === "POST" ? { body: MCP_INITIALIZE } : {}),
      });
      problem = expect(res, text ? await boundedText(res) : "");
    } catch { problem = "请求、读取或响应校验失败（不输出响应内容）"; }
    finally { await res?.body?.cancel().catch(() => {}); }
    log(`${problem ? "失败" : "通过"} ${label}${problem ? `  ${problem}` : ""}`);
    if (problem) result.failed++;
    return !problem;
  }
  const okType = (type: RegExp): Expect => (res) => statusProblem(res, 200, !!access)
    ?? (type.test(res.headers.get("content-type") ?? "") ? null : "响应类型不符");
  const okPage: Expect = (res, body) => statusProblem(res, 200, !!access) ?? pageProblem(res, body, site.name);
  const denied: Expect = (res) => statusProblem(res, 401, true);
  const mcp = (authenticated = false) => check(`${authenticated ? "认证" : "匿名"} /api/mcp initialize`, "/api/mcp",
    access ? (res) => statusProblem(res, authenticated ? 403 : 401, true) : (res, body) => handshakeProblem(res, body, site.mcpPrefix),
    { method: "POST", text: !access, authenticated });
  const modulePages = (options.modules ?? []).flatMap((m) => (m.pages ?? []).flatMap((entry) => "pages" in entry ? entry.pages : [entry]))
    .map((p) => `/${p.path}`).filter((p) => !/[:*?]/.test(p));
  const pages = [...new Set([...PAGES, ...modulePages, ...(access ? [access.loginPath] : [])])];

  if (!mcpOnly) {
    for (const path of pages) {
      const guard = access ? pageGuard(access, path) : "open";
      if (access && guard === "session") {
        await check(`匿名页面 ${path}`, path, (res) => redirectProblem(res, loginLocation(access, path), base));
      } else {
        // /admin/login is the existing admin sign-in, not a member-session success.
        let assets: ReturnType<typeof loginAssets> = [];
        await check(`匿名页面 ${path}`, path, (res, body) => {
          const problem = okPage(res, body);
          if (!problem && access && path === access.loginPath) assets = loginAssets(body, base);
          return problem;
        }, { text: true });
        for (const [i, asset] of assets.entries()) await check(`匿名登录资源 ${i + 1}`, asset.path, okType(asset.type));
      }
    }
    for (const [path, type] of MACHINE) {
      await check(`匿名 ${path}`, path, access && !OPEN_MACHINE.has(path) ? denied : (res, body) => {
        const problem = okType(type)(res, body);
        if (problem || !access || path !== "/api/health") return problem;
        const value = JSON.parse(body);
        return value?.ok === true && Object.keys(value).length === 1 ? null : "匿名健康检查应只返回 ok";
      }, { text: !!access && path === "/api/health" });
    }
    if (access) {
      for (const path of [access.sessionPath, "/api/admin/me"]) await check(`匿名 ${path}`, path, denied);
      for (const path of ["/api/v1/items", "/feed.xml", "/api/v1/agent", "/robots.txt", "/sitemap.xml"]) await check(`匿名 HEAD ${path}`, path, denied, { method: "HEAD" });
    }
  }
  await mcp();

  if (access) {
    if (!cookie) {
      log("认证检查未执行：未提供会话 Cookie；本次仅验证匿名边界，不代表全部上线验收完成。");
      if (options.requireAuth) { result.failed++; log("失败 --require-auth：正式发布闸门要求有效会话。"); }
    } else {
      const identityOk = await check("认证会话身份", access.sessionPath, (res, body) => statusProblem(res, 200, true)
        ?? (/json/i.test(res.headers.get("content-type") ?? "") && validPrincipal(JSON.parse(body)) ? null : "会话身份结构无效"), { authenticated: true, text: true });
      if (!identityOk) { result.auth = "failed"; log("授权读取未执行：会话身份验证失败。"); }
      else {
        const before = result.failed;
        if (!mcpOnly) {
          for (const path of pages.filter((p) => pageGuard(access, p) === "session")) await check(`认证页面 ${path}`, path, okPage, { authenticated: true, text: true });
          for (const [path, type] of MACHINE) await check(`认证 ${path}`, path, okType(type), { authenticated: true });
        }
        await mcp(true);
        result.auth = result.failed === before ? "passed" : "failed";
      }
    }
  }
  log(result.failed ? `${result.failed} 项检查失败。` : result.auth === "not-run" ? "匿名边界检查通过；认证检查未执行。" : "本次验收检查通过。");
  return result;
}

if (import.meta.main) {
  try {
    const args = checkArgs(process.argv.slice(2), "smoke", process.env.SITE_URL);
    const access = siteAccess(MODULES);
    if (!access && (args.cookieFd !== null || args.requireAuth)) throw new CheckInputError("公开站没有内部会话验收；不会读取或发送 Cookie");
    const cookie = await readSessionCookie(args.cookieFd);
    const result = await runSmoke({ base: args.base, access, site: SITE, modules: MODULES, cookie, requireAuth: args.requireAuth });
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof CheckInputError ? error.message : "验收失败（不输出异常或响应内容）。");
    process.exitCode = 1;
  }
}

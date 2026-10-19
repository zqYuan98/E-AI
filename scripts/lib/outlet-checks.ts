// Pure checks shared by the deploy smoke test and the MCP contract check. Never include received data
// (headers, bodies or credentials) in diagnostics: even an error response can contain private content.
import type { AccessPrincipal } from "@aihot/contracts/access";

export class CheckInputError extends Error {}

export interface CheckArgs {
  base: string;
  mcpUrl: string;
  cookieFd: number | null;
  requireAuth: boolean;
  anonymousOnly: boolean;
  full: boolean;
}

export function checkArgs(args: string[], kind: "smoke" | "mcp", siteUrl?: string): CheckArgs {
  let base: string | undefined;
  let endpoint: string | undefined;
  let cookieFd: number | null = null;
  let requireAuth = false, anonymousOnly = false, full = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base" && !base && args[i + 1] && !args[i + 1].startsWith("--")) base = args[++i];
    else if (arg === "--require-auth") requireAuth = true;
    else if (arg === "--anonymous-only") anonymousOnly = true;
    else if (arg === "--cookie-stdin" && cookieFd === null) cookieFd = 0;
    else if (arg === "--cookie-fd" && cookieFd === null && /^(?:0|[3-9]|[1-9][0-9]+)$/.test(args[i + 1] ?? "")) {
      cookieFd = Number(args[++i]);
      if (!Number.isSafeInteger(cookieFd)) throw new CheckInputError("会话文件描述符无效");
    } else if (arg === "--full" && kind === "mcp") full = true;
    else if (kind === "mcp" && !arg.startsWith("--") && !endpoint) endpoint = arg;
    else throw new CheckInputError("验收参数无效；Cookie 只能从 --cookie-stdin 或 --cookie-fd 读取");
  }
  if (anonymousOnly && (requireAuth || cookieFd !== null)) throw new CheckInputError("--anonymous-only 不能与认证验收参数同时使用");
  if (base && endpoint) throw new CheckInputError("请只指定一个验收地址");
  const target = endpoint ?? base ?? siteUrl;
  if (!target) throw new CheckInputError("必须用 --base、MCP 地址或 SITE_URL 明确指定验收目标");
  let url: URL;
  try { url = new URL(target); } catch { throw new CheckInputError("验收地址无效"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash
    || (endpoint ? url.pathname !== "/api/mcp" : url.pathname !== "/")) {
    throw new CheckInputError("验收地址必须是无凭据、无查询参数的站点根地址（MCP 使用 /api/mcp）");
  }
  return { base: url.origin, mcpUrl: `${url.origin}/api/mcp`, cookieFd, requireAuth, anonymousOnly, full };
}

/** One Cookie header, optionally followed by the pipe's final newline. No command-line secret option. */
export function sessionCookie(input: string): string {
  const value = input.replace(/\r?\n$/, "");
  if (!value || Buffer.byteLength(input) > 8192 || !value.split(/; */).every((part) => /^[!#$%&'*+\-.^_`|~\w]+=[\x21-\x3a\x3c-\x7e]+$/.test(part))) {
    throw new CheckInputError("会话输入必须是单行 Cookie 请求头的值，且不超过 8 KiB");
  }
  return value;
}

export function privateProblem(res: Response): string | null {
  const directives = (res.headers.get("cache-control") ?? "").toLowerCase().split(",").map((v) => v.trim());
  return directives.includes("private") && directives.includes("no-store") && !directives.includes("public")
    && !directives.some((v) => /^s-maxage\s*=/.test(v)) ? null : "缺少 private, no-store 或存在共享缓存指令";
}

export function statusProblem(res: Response, expected: number, internal = false): string | null {
  return res.status !== expected ? `HTTP ${res.status}，预期 ${expected}` : internal ? privateProblem(res) : null;
}

export function validPrincipal(value: unknown): value is AccessPrincipal {
  if (!value || typeof value !== "object") return false;
  const v = value as AccessPrincipal;
  return (v.kind === "member" || v.kind === "admin") && typeof v.id === "string" && new RegExp(`^${v.kind}:[1-9][0-9]*$`).test(v.id)
    && typeof v.name === "string" && typeof v.csrf === "string" && !!v.csrf;
}

export function pageProblem(res: Response, body: string, siteName: string): string | null {
  if (!/text\/html/i.test(res.headers.get("content-type") ?? "")) return "页面响应类型不是 HTML";
  const htmlName = siteName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  return body.includes(siteName) || body.includes(htmlName) ? null : "页面缺少站点标识";
}

export function redirectProblem(res: Response, expected: string, base: string): string | null {
  if (res.status !== 302) return `HTTP ${res.status}，预期 302 登录重定向`;
  try {
    const given = new URL(res.headers.get("location") ?? "", base);
    if (given.href !== new URL(expected, base).href) return "登录重定向目标不符";
  } catch { return "登录重定向目标无效"; }
  return privateProblem(res);
}

export const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" },
  },
});

/** Accept JSON or SSE, but only a successful initialize result, never a name embedded in an error. */
export function handshakeProblem(res: Response, body: string, name: string): string | null {
  if (res.status !== 200) return `HTTP ${res.status}，预期 200`;
  const type = res.headers.get("content-type") ?? "";
  const frames = /text\/event-stream/i.test(type)
    ? body.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter(Boolean)
    : /application\/json/i.test(type) ? [body] : [];
  let initialized = false;
  for (const frame of frames) {
    try {
      const value = JSON.parse(frame);
      if (value?.id !== 1) continue;
      if (value.jsonrpc !== "2.0" || value.error || value.result?.serverInfo?.name !== name
        || typeof value.result?.protocolVersion !== "string" || !value.result?.capabilities || typeof value.result.capabilities !== "object") return "MCP initialize 结果无效";
      initialized = true;
    } catch { return "MCP initialize 不是有效协议响应"; }
  }
  return initialized ? null : "缺少 MCP initialize 成功结果";
}

/** Only login scripts/styles on the caller's origin are ever probed, never arbitrary links or redirects. */
export function loginAssets(html: string, base: string): Array<{ path: string; type: RegExp }> {
  const found = new Map<string, RegExp>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const script = /^<script\b/i.test(tag);
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] ?? "";
    if (!script && !/^(?:stylesheet|modulepreload)$/i.test(rel)) continue;
    const attr = tag.match(script ? /\bsrc=["']([^"']+)["']/i : /\bhref=["']([^"']+)["']/i)?.[1];
    if (!attr) continue;
    const url = new URL(attr.replaceAll("&amp;", "&"), base);
    if (url.origin !== new URL(base).origin || url.username || url.password) throw new CheckInputError("登录资源指向其他来源；不会请求该目标");
    found.set(url.pathname + url.search, rel === "stylesheet" ? /text\/css/i : /javascript/i);
    if (found.size > 64) throw new CheckInputError("登录资源数量异常");
  }
  return [...found].map(([path, type]) => ({ path, type }));
}

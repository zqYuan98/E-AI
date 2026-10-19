// Public: full SDK contract (identity, exact tools, reads, domain errors and schema validation).
// Internal: assert anonymous 401 and, with a verified session, authenticated 403; never skip the check.
// node scripts/mcp-check.ts <url> [--full] [--anonymous-only | --require-auth --cookie-stdin]
// --cookie-fd 3 also accepts a Cookie header via an inherited descriptor, never a command-line value.
import type { Client } from "@modelcontextprotocol/client";
import { PUBLIC_INTERFACE_VERSION } from "@aihot/contracts/http-policy";
import { MCP_TOOL_NAMES as T, MCP_TOOLS, mcpToolName } from "@aihot/contracts/mcp";
import { SITE } from "@aihot/site";
import { MODULES } from "@aihot/site/modules";
import { siteAccess } from "@aihot/contracts/access";
import { CheckInputError, checkArgs } from "./lib/outlet-checks.ts";
import { readSessionCookie, runInternalMcpChecks } from "./smoke.ts";

export async function runPublicMcpCheck(url: URL, full = false) {
  checkArgs([url.href], "mcp");
  // Neither backend modules nor the SDK initialize in the internal-denial branch.
  const { SERVER_MODULES } = await import("@aihot/site/modules/server");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const moduleTools = SERVER_MODULES.flatMap((m) => m.agent?.abilities ?? []).map((a) => ({
    name: mcpToolName(a.mcp.tool), args: a.mcp.checkArgs, input: a.mcp.input,
  }));
  const client = new Client({ name: `${SITE.mcpPrefix}-mcp-check`, version: "1.0.0" });

  function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  }
  function errorCode(result: Awaited<ReturnType<Client["callTool"]>>): string | null {
    const structured = result.structuredContent as { error?: { code?: unknown } } | undefined;
    return typeof structured?.error?.code === "string" ? structured.error.code : null;
  }
  async function call(name: string, args: Record<string, unknown>, expect: { error?: boolean; code?: string } = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = firstText(result);
    const gotError = result.isError === true;
    // Do not log arguments or any response text/structured content, even for the public branch.
    console.log(`MCP 工具 ${name}：${gotError ? "业务错误响应" : "成功响应"}`);
    if (gotError !== (expect.error ?? false)) throw new Error(`${name}: unexpected success/error result`);
    if (expect.code && errorCode(result) !== expect.code) throw new Error(`${name}: unexpected error code`);
    if (!gotError && (!text || !result.structuredContent)) throw new Error(`${name}: missing readable or structured result`);
    return result;
  }

  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.href !== url.href) throw new Error("MCP requested a different target");
    const signals = [AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])];
    return fetch(input, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: localFetch, requestInit: { redirect: "manual" } }));
    const info = client.getServerVersion?.();
    if (info?.name !== SITE.mcpPrefix) throw new Error("MCP server name mismatch");
    if (info?.version !== PUBLIC_INTERFACE_VERSION) throw new Error("MCP server version mismatch");

    const listed = await client.listTools();
    const actualNames = listed.tools.map((tool) => tool.name).sort();
    const expectedNames = [...MCP_TOOLS.map((tool) => tool.name), ...moduleTools.map((tool) => tool.name)].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("MCP tool list mismatch");

    // These reads remain valid on a fresh public site.
    await call(T.latest, { limit: 2 });
    await call(T.search, { q: "OpenAI", limit: 2 });
    await call(T.hot, { limit: 3 });
    for (const tool of moduleTools) {
      if (tool.args !== undefined) await call(tool.name, tool.args);
      else if ((await tool.input.safeParseAsync({})).success) await call(tool.name, {});
      else console.log(`MCP 工具 ${tool.name}：仅校验发现契约（无可用的空参数）`);
    }
    // Missing reports/stories and schema validation still exercise all remaining tools.
    await call(T.daily, { date: "2026-02-30" }, { error: true, code: "invalid_request" });
    await call(T.weekly, { week: "2026-W54" }, { error: true, code: "invalid_request" });
    await call(T.monthly, { month: "2026-13" }, { error: true, code: "invalid_request" });
    await call(T.story, { public_id: "__mcp_check_missing__", report_limit: 3 }, { error: true, code: "not_found" });
    await call(T.latest, { limit: 99 }, { error: true });

    if (full) {
      for (const name of [T.daily, T.weekly, T.monthly]) await call(name, {});
      const hot = await call(T.hot, { limit: 1 });
      const storyId = ((hot.structuredContent as { items?: Array<{ links?: { story?: string } }> }).items?.[0]?.links?.story ?? "").split("/").pop();
      if (!storyId) throw new Error("--full needs a populated public story");
      await call(T.story, { public_id: storyId, report_limit: 3 });
    }
    console.log("公开 MCP 完整契约检查通过。");
  } finally { await client.close(); }
}

if (import.meta.main) {
  try {
    const args = checkArgs(process.argv.slice(2), "mcp", process.env.SITE_URL);
    const access = siteAccess(MODULES);
    if (access) {
      if (args.full) throw new CheckInputError("内部站禁用 MCP POST；--full 只用于公开 MCP 契约检查");
      const cookie = await readSessionCookie(args.cookieFd);
      const result = await runInternalMcpChecks({ base: args.base, access, site: SITE, cookie, requireAuth: args.requireAuth });
      process.exitCode = result.failed ? 1 : 0;
    } else {
      if (args.cookieFd !== null || args.requireAuth) throw new CheckInputError("公开 MCP 检查不读取或发送内部会话 Cookie");
      await runPublicMcpCheck(new URL(args.mcpUrl), args.full);
    }
  } catch (error) {
    console.error(error instanceof CheckInputError ? error.message : "MCP 契约检查失败（不输出异常、凭据或响应内容）。");
    process.exitCode = 1;
  }
}

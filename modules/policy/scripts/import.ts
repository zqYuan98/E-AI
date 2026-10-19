// 手动收录政策文件（首批种子、抓不到的原文）：读原文页正文，存成“政策规划·手动收录”信源的资料，再立即抽取入库。
// 后台“政策库管理”可以做同样的事（粘贴网址，worker 逐条处理）；这个脚本留给服务器上批量导入。
//   node --env-file=.env modules/policy/scripts/import.ts <原文网址> [<原文网址> ...]
//   node --env-file=.env modules/policy/scripts/import.ts --file <每行一个网址的文本文件>
import { readFileSync } from "node:fs";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { extractArticle, fetchMaterial } from "../backend/import.ts";
import { policy } from "../server.ts";

// 模型步骤“policy”由模块登记，脚本单独运行时也要先装上。
installModules([policy]);

const args = process.argv.slice(2);
const urls = args[0] === "--file" ? readFileSync(args[1]!, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)) : args;

for (const url of urls) {
  // 一个网址出错（打不开、模型超时）不影响后面的。
  try {
    const articleId = await fetchMaterial(url);
    const docId = await extractArticle(articleId);
    console.log(JSON.stringify({ url, articleId, docId }));
  } catch (error) {
    console.log(JSON.stringify({ url, status: `failed: ${String(error instanceof Error ? error.message : error).slice(0, 160)}` }));
  }
}
await stopBoss();
await closeDb();

# 政策规划库（modules/policy）

国家部委、国家电网、南方电网、发电集团等发布的规划、行动方案、指导意见、通知和白皮书，每份文件一行，放在 `/policy`。
资讯流只收和人工智能直接相关的新闻；这里不要求 AI 是主题，但每份文件单独标出其中的 AI 条款。

## 怎么进库

- **自动**：定时任务 `policy.extract`（每 15 分钟）从已经抓到正文的资料里挑候选：打了 `政策规划` 标签的信源的全部资料，以及标题像正式文件的资料（含“规划”“行动方案”“实施意见”等）。模型读一遍，判断是不是政策规划类，并抽取文号、日期、发文单位、目标指标、重点任务和 AI 条款。
- **后台**：“资料 → 政策库管理”粘贴原文网址（每行一个）或点“导入首批种子”（`seeds.txt`），worker 每分钟处理几条，结果在页面上；抽取有误的文件可以隐藏、删除或重新抽取。要“模型调用”在运行中。
- **手动**：在服务器上批量收录也可以用脚本，网址写进 `seeds.txt` 或直接给出：
  ```bash
  docker compose exec worker node modules/policy/scripts/import.ts --file modules/policy/seeds.txt
  docker compose exec worker node modules/policy/scripts/import.ts https://www.nea.gov.cn/...
  ```
  手动收录的资料归在“政策规划·手动收录”信源下（`isolated`，不进资讯流）。

## 核对规则（backend/extract.ts 的 `ground`）

- 每条目标、任务、AI 条款都带原话；原话在正文里找不到（含拼接、省略号）就丢掉。
- 目标的数值要出现在原话里，且要有数字；申报截止、推荐名额、资格条件不算目标。
- 文号、印发日期、发文单位要在正文里找得到，否则置空。
- 文件名或发文单位写明了国家电网 / 南方电网的，层级以它为准。

## 合并

同一份文件按名称合并（“某某印发《X》的通知”取 X，“某部门关于……”从“关于”取起）。原文胜过官方解读，解读胜过报道：更好的来源到了才替换要素，文号和日期只补不丢。

## 页面与接口

- `/policy`：筛选（层级、AI 相关程度、类型）、关键目标对照（写明年份的目标）、文件列表。
- `/policy/:id`：要素、目标与关键数据、AI 条款、重点任务（都附原话），以及原文、解读与报道。
- `GET /api/site/policy?level=&type=&ai=any|core&q=`、`GET /api/site/policy/:id`。

模型步骤叫 `policy`（后台“模型与评测”可改，环境变量 `POLICY_MODEL`），提示词是 `industry/prompts/policy-extract.md`。

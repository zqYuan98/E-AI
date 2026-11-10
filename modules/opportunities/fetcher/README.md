# 采集服务（fetcher）

项目商机模块的内部采集服务。它用无头 Chromium 打开国网电子商务平台（ECP）和电工交易专区（ETP）的公开页面，列出采购/招标公告，下载单个公告的“公告文件”并解析其中的需求表，按 `../types.ts` 里的 `FetcherNotice` / `FetcherResult` 返回 JSON。worker 通过内部网络调用它，不对外发布端口。

代码：`sgcc/sources.py`（浏览器访问）、`sgcc/parsing.py`（附件解析，ZIP / XLSX / XLS / DOCX）、`sgcc/server.py`（HTTP 服务）。

## 接口

所有请求都要带 `Authorization: Bearer <FETCHER_TOKEN>`，包括 `/health`。请求体为 JSON，不超过 16 KiB。

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| `GET /health` | — | `{"ok": true}` |
| `POST /discover` | `{"source": "ecp"\|"etp", "category": "procurement"\|"tender", "limit": 1..20}`（`limit` 默认 10） | `{"notices": [FetcherNotice]}` |
| `POST /fetch` | `{"url": 公告详情链接}` | `FetcherResult` |

`/fetch` 只接受两个来源的公告详情链接（`/discover` 返回的 `url`）。返回里 `items` 的 `evidence` 只有 `{file, sheet, row}`；`notice.metadata` 保留 `procurement_file_deadline`、`opening_time`、`batch_name` 等原文字段；`complete` 表示附件全部解析成功；`warnings` 最多 50 条。

出错时返回 `{"error": {"code", "message", "retryable"}}`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `bad_request` | 400 / 404 / 405 / 413 | 请求格式、参数或链接不对 |
| `unauthorized` | 401 | 令牌缺失或错误 |
| `busy` | 503 | 等了 5 分钟仍有任务在跑（`retryable: true`） |
| `network` | 502 | 网络错误或超时（`retryable: true`） |
| `rate_limit` / `captcha` / `needs_login` | 502 | 来源限频、要求验证或登录；不会绕过，需要人工 |
| `no_attachment` | 502 | 没有公开的公告文件，或文件为空、超过 50 MiB、不是 ZIP/OLE/PDF |
| `unknown_layout` | 502 | 页面或数据结构和已验证的不一致 |
| `parse_error` / `internal` | 500 | 解析或服务内部出错 |

## worker 怎么用

1. 定时 `POST /discover`，按 `source + external_id` 去重，新公告记为待取附件。
2. 对每条新公告 `POST /fetch`，把 `items` 存为需求行，`complete` 为 false 时标部分解析；`no_attachment` 记为没有附件，`rate_limit` / `captcha` / `needs_login` 记为需要人工，只有 `retryable: true` 的才在下一轮再试。
3. 任务是串行的（同一时间只开一个浏览器）。单次超时：discover 150 秒、fetch 300 秒，排队最多 5 分钟，所以客户端超时要设到 11 分钟左右，并且不要并发调用。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `FETCHER_TOKEN` | 必填，至少 24 个可见 ASCII 字符（不含空格），否则拒绝启动。worker 用同一个值。 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Chromium 路径。镜像里已设为 `/usr/bin/chromium`。 |

服务监听 `0.0.0.0:8000`，只应接在容器内部网络上，不要映射端口。镜像以非 root 用户运行；compose 里建议加 `init: true`，回收 Chromium 子进程。

构建参数：`APT_MIRROR`（默认 `deb.debian.org`）、`PIP_INDEX_URL`（默认 `https://pypi.org/simple`）。

## 安全边界

- 只访问两个固定来源主机（HTTPS 443），启动前确认域名解析到公网地址，并把浏览器的域名解析固定到这个地址。同一主机上的任何路径都放行（网站的反爬脚本放在随机路径，必须让它正常运行）；其他主机、WebSocket、Service Worker 一律拦截。
- 不重放、不伪造接口请求，也不生成网站的动态参数；所有接口都由页面自己的脚本发出。
- 只点击精确文字“下载公告文件”，从弹出窗口取下载；从不点击“获取采购文件”，不登录、不购买、不自动重试。遇到登录、验证码、限频直接报错。
- 下载文件不超过 50 MiB，按文件头判断类型（ZIP / OLE / PDF），HTML 页面视为错误；文件名由服务生成，不用来源给的名字。文件只在临时目录里解析，请求结束即删除；附件内的文件不解压到磁盘、不执行。
- 日志每个任务一行 JSON（来源、类型、成功或错误码、条数、耗时），不记录令牌、Cookie 和页面内容。

## 测试

测试不联网、不启动真浏览器：

```bash
python -I -m pytest modules/opportunities/fetcher/tests
```

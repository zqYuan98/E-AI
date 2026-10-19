# 电力 AI 信源候选测试记录

测试日期：2026-10-14。方法：用项目真实解析器（`fetchWebList` / `fetchJsonList` / `fetchRss` + `fetchDetail`）预览，要求 ≥5 条真实文章、日期可解析（列表或详情页实测 2 篇）、内容与电力/能源/政策相关。配置全部写在 `industry/sources.json`，`node .data/check-sources.ts` 通过。

## 已接入（45 个网页/RSS/JSON + 10 个公众号）

### 政策规划（政府、协会）

| id | 名称 | 类型 | 层级 | 条数 | 日期来源 | 备注 |
|---|---|---|---|---|---|---|
| web-ndrc-tz | 国家发改委·通知 | web_list | T1 | 25 | 列表 span | 十五五能源/电力规划常在此发 |
| web-ndrc-fzggwl | 国家发改委·发展改革委令 | web_list | T1 | 25 | 列表 span | 低频 |
| web-ndrc-jd | 国家发改委·政策解读 | web_list | T1 | 25 | 列表 span | |
| web-ndrc-xwfb | 国家发改委·新闻发布 | web_list | T1 | 25 | 列表 span | |
| json-nea-zxwj | 国家能源局·最新文件 | json_list | T1 | 10 | JSON publishTime | 页面为新华云 JS 渲染，读 ds_*.json；通知+公告的超集 |
| json-nea-jd | 国家能源局·政策解读 | json_list | T1 | 10 | JSON | |
| json-nea-nyyw | 国家能源局·能源要闻 | json_list | T1 | 10 | JSON | 与 web-nea（首页）部分重叠，按网址去重 |
| json-gov-zuixin | 中国政府网·最新政策 | json_list | T1 | 1101 | JSON DOCRELPUBTIME | 全量历史，首导只取 10 条 |
| web-sasac-zcfb | 国资委·政策发布 | web_list | T1 | 29 | 列表 span | 标题取 a@title（链接文字被截断） |
| web-sasac-xwfb | 国资委·新闻发布 | web_list | T1 | 28 | 列表 span | |
| web-sasac-qydt | 国资委·央企动态 | web_list | T1 | 30 | 列表 span | 混有非电力央企 |
| web-nda-zcfb | 国家数据局·政策发布 | web_list | T1 | 15 | 列表 span（2026.07.08） | |
| web-nda-xwfb | 国家数据局·新闻发布 | web_list | T1 | 13 | 列表 span | |
| json-cec-hyyw | 中电联·行业要闻 | json_list | T1_5 | 20 | JSON epoch_ms | 站点是 JS 应用，读 /ms-mcms/mcms/content/list?id= |
| json-cec-dt | 中电联·中电联动态 | json_list | T1_5 | 20 | JSON | |
| json-cec-bwxx | 中电联·部委信息 | json_list | T1_5 | 20 | JSON | 转发发改委/能源局文件 |
| json-cec-bzhdt | 中电联·标准化动态 | json_list | T1_5 | 20 | JSON | |
| json-cec-yjzq | 中电联·标准征求意见 | json_list | T1_5 | 20 | JSON | |

### 电网与发电集团

| id | 名称 | 类型 | 层级 | 条数 | 日期来源 | 备注 |
|---|---|---|---|---|---|---|
| web-csg-gsyw | 南方电网·公司要闻 | web_list | T1 | 19 | 列表 span | URL 含年份，2027 年要改 |
| web-csg-yxcz | 南方电网·一线传真 | web_list | T1 | 20 | 列表 span | 同上 |
| web-csg-nygc | 南方电网·能源观察 | web_list | T1_5 | 20 | 列表 span | 条目全部链到 mp.weixin 文章 |
| web-sgcc-js-gsyw | 国网江苏电力·公司要闻 | web_list | T1 | 10 | 列表 i | 每周 1–2 篇 |
| web-sgcc-yw-via-sx | 国家电网·要闻（国网山西转载） | web_list | T1 | 13 | 列表 span | **enabled:false**：约 1/3 标题被截断，详情在 sgcc.com.cn（412）抓不到 |
| web-ceic-jtyw | 国家能源集团·集团要闻 | web_list | T1 | 10 | 详情页正则「发布时间：」 | |
| web-datang-jtxw | 中国大唐·集团新闻 | web_list | T1 | 12 | 列表 .news-item-date | |
| web-spic-jtyw | 国家电投·集团要闻 | web_list | T1 | 10 | 列表 p | |
| web-ctg-home | 三峡集团·首页要闻 | web_list | T1 | 12 | 列表 span | 列表标题会截断，配置详情页 `<title>` 覆盖标题 |
| web-powerchina-gsyw | 中国电建·公司要闻 | web_list | T1 | 6 | 列表 span | |
| web-ceec-gsyw | 中国能建·公司要闻 | web_list | T1 | 6 | 网址中的 /art/2026/10/12/ | 栏目页列表在 script CDATA 里，改抓首页 |

### 行业媒体

| id | 名称 | 类型 | 层级 | 条数 | 日期来源 |
|---|---|---|---|---|---|
| web-cpnn-kj | 中国能源新闻网·科技 | web_list | T2 | 15 | 列表 b.fr |
| web-cpnn-dianli | 中国能源新闻网·电力 | web_list | T2 | 15 | 列表 b.fr |
| web-cpnn-nyqy | 中国能源新闻网·企业 | web_list | T2 | 15 | 列表 b.fr |
| json-cnenergynews-dwdl | 中国能源报·电网电力 | json_list | T2 | 20 | JSON ctime epoch_ms |
| json-xinhua-energy | 新华网·新华能源 | json_list | T2 | 997 | JSON publishTime（每次约 1.4MB） |
| web-inen-power-news | 国际电力网·资讯 | web_list | T2 | 60 | 详情页 p.source b |
| web-inen-power-tech | 国际电力网·技术 | web_list | T2 | 150 | 列表 .prompt i（更新慢） |
| web-cpem-szdl | 全国电力设备管理网·数智电力 | web_list | T2 | 10 | 列表 span.sj |
| web-cpem-dlzx | 全国电力设备管理网·电力资讯 | web_list | T2 | 10 | 列表 span.sj |
| web-bjx-spd-yw | 北极星输配电网·要闻 | web_list | T2 | 64 | 列表 span（混有招标） |
| web-bjx-spd-js | 北极星输配电网·技术 | web_list | T2 | 64 | 列表 span |
| rss-latitude-media | Latitude Media | rss | T2 | 10 | RSS（AI/数据中心×电网，最相关） |
| rss-powermag | POWER Magazine | rss | T2 | 10 | RSS |
| rss-tdworld | T&D World | rss | T2 | 25 | RSS |
| rss-canary-media | Canary Media | rss | T2 | 100 | RSS |
| rss-energy-storage-news | Energy-Storage.news | rss | T2 | 300 | RSS |

### 公众号（mp_account，全部 enabled:false，需极致了 key）

原始 ID 取自文章页源码 `user_name = "gh_…"` 与 `nickname`。

| id | 公众号 | ghid | 证据 |
|---|---|---|---|
| mp-nea | 国家能源局 | gh_204dae95445b | https://mp.weixin.qq.com/s/oiqRiBRhMM96uQF1lBRWoA |
| mp-ndrc | 国家发展改革委 | gh_bb11686e0930 | https://mp.weixin.qq.com/s/d4-JtV3q3WE5M9avTzgbBg |
| mp-nda | 国家数据局 | gh_66b0b452f85e | https://mp.weixin.qq.com/s/vHKRsdKjxpoYLGEuTo9dpw |
| mp-cec | 中国电力企业联合会 | gh_33d7e5ae885a | https://mp.weixin.qq.com/s/wnNmm_akRvWjNuKABKFcrw |
| mp-cec-xinmei | 电联新媒 | gh_c550b6404510 | https://mp.weixin.qq.com/s/nENo5gH7BK4zxGqMj5F79Q |
| mp-csg-50hz | 南网50Hz（南方电网官方号） | gh_162f3553374e | https://mp.weixin.qq.com/s/wzHEPWaoU6A1jGwGC_Saag |
| mp-cepn | 中国电力报 | gh_fe77e4775c8a | https://mp.weixin.qq.com/s/8Hd2rTERrywB5vmgD8Y0Tg |
| mp-cnenergy | 中国能源报 | gh_9565400a2c89 | https://mp.weixin.qq.com/s/B-fWs56-2m37VQuezcpaeA |
| mp-sasac | 国资小新 | gh_162762a657a6 | https://mp.weixin.qq.com/s/zL1ceCWXY6GuJPOmuS_a7w |
| mp-eo | 南方能源观察 | gh_99175221837b | https://mp.weixin.qq.com/s/OYAQomYN_NFA9Sc4qN1d4Q |

未找到原始 ID 的证据：国家电网、电网头条/国家电网报、南方电网报、国网能源研究院、南网能源院（检索到的文章已删除、账号已迁移或 __biz 链接要求验证）。

## 测试过但未接入

| 候选 | 原因 |
|---|---|
| www.sgcc.com.cn、sgeri / epri / sgitg.sgcc.com.cn | 412 JS 风控 |
| indaa.com.cn（英大网/国家电网报）、epaper.indaa.com.cn | 412 / 502 |
| sgcctop.com（电网头条） | 403 WAF |
| 国网省公司站 bj sd ah fj hb hl jl xj gs nx qh zj | 412；sh、mx 202/502；he hn sc cq jx ln tj 标题截断且无 title 属性 |
| 国网华东分部 ec.sgcc.com.cn | 条目少、标题截断、列表日期无年份 |
| 华能 chng.com.cn | 链接写在 onclick，无 href |
| 华电 chd.com.cn | JSONP 接口，json_list 不支持 |
| 三峡 jtyw44 栏目页 | 标题由 document.write 输出（改用首页） |
| 南网 媒体关注 mtgz | 全部外链到约 9 个媒体域名 |
| 南网分子公司站 gd gz hn sz ehv gx yn | JS 挑战页或连不上；未找到南网能源院/科研院独立官网 |
| 国家电投 /2021/xwzx/gjdt/ | 404 |
| 工信部 miit.gov.cn | 列表接口无浏览器会话返回 success:false；站内搜索接口无法按栏目过滤 |
| 发改委 规划文本 ghwb | 停更（最新 2024-12） |
| 发改委 规范性文件 ghxwj | 可用但低频（最新 2026-05），未加 |
| 发改委 公告 gg | 多为配额等无关内容 |
| 能源局 通知 tz、公告 gg（json） | 可用，但是「最新文件」的子集，未加 |
| 政府网 国务院部门文件 bmwj JSON | 可用但 3.3MB、12802 条、各部委混杂，未加 |
| 政府网 国务院文件 gwywj JSON | 与最新政策重复（不同网址会产生重复） |
| 政府网 政策解读 ZCJD_QZ.json | 2MB，专题置顶不按时间 |
| 国资委 政策解读 | 停更（2025-12） |
| 国家数据局 通知公告 | 几乎全是大赛通知 |
| 中电联 国家政策(305)/研究成果(472)/新颁标准(287) | 停更或很低频 |
| 中国电力网 chinapower.com.cn | 403 / HTTPS 握手失败；电力信息化栏目最新 2026-04 |
| 人民网能源 energy.people.com.cn | 频道已撤，跳转财经 |
| cpem 电力科技 list99 | 停更（2024-11） |
| 中国能源报·科技 | 泛科学，与电力弱相关 |
| eo.com.cn（南方能源观察） | 403 |
| cepm.com.cn（中国电力企业管理） | SSL/连接失败 |
| inengyuan.com（能源杂志） | 可解析但以油气煤炭通稿为主 |
| EPRI | 纯 JS 单页、无 RSS |
| IEA news | 403、无 RSS |
| ENTSO-E | 无 RSS |
| Smart Energy International | 503 |
| FERC rss | 403 |
| DOE rss | 内容陈旧 |
| RTO Insider feed | 链接为 `//www…` 省略协议，解析器不补全，全部被过滤 |
| DatacenterDynamics RSS | 可用，但以 IT 数据中心为主 |
| Renewable Energy World | 403 |
| 知网 RSS（中国电机工程学报 ZGDC / 电网技术 DWJS） | 可用，但文章链接带一次性 token，每次抓取网址都变，会重复入库；需自定义适配 |

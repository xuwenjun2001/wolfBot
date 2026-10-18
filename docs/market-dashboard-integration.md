> 后续实施状态：2026-09-06 已完成原生模块接入。启动方式、已实现功能及与原包的差异见[原生行情看板](market-dashboard.md)。以下保留初始评估，文中的“本次仅评估”“未实施”指当时的评估阶段。

评估日期：2026-09-06。对象：`extend/dashboard.cmd`，依据已安全解码的 `tmp/dashboard-inspection/dashboard.html` 与 `tmp/dashboard-inspection/server.ps1`。

**结论：可行。适合先作为本机“行情看板”入口验证；正式面向远程、多用户使用时，应将数据能力迁入现有 Python market-data 服务，再由 wolfbot 的鉴权 API 提供给页面。** 本地 iframe 是可复用现有界面的最小方案，但不能据此认定已经完成生产集成。

本次仅开展静态检查、目录存在性检查和现有 `127.0.0.1:8765/health` 的轻量查询。没有执行 CMD/PowerShell 脚本包、启动浏览器、启动新服务、调用行情上游、修改业务源码或生产配置。唯一新增文件为本报告。浏览器安全行为另参考 MDN 与 Chrome 官方文档；未进行实际浏览器兼容性验证。

**交付物的真实形态与依赖**

`dashboard.cmd` 约 1.25 MB，是 Windows 启动及打包外壳。第 4 行以 `Invoke-Expression` 执行自身尾部脚本；第 18 行设置 `%TEMP%/sector-flow-dashboard-portable`；第 10247–10252 行只解码写出 HTML 和 `start_dashboard.ps1`，随后执行 PowerShell。后续接入应基于可审查的解码源码，不让 Web 请求执行这份启动包。

- HTML 882,641 字节，约 4,425 行；一个内联 style、一个内联 script，原生 DOM、CSS、SVG 绘图。没有发现 React、ECharts 或需要安装的前端图表 SDK；东方财富 JSONP 是运行时动态插入的远程脚本。
- PowerShell 37,263 字节，约 1,061 行；依赖 Windows PowerShell/.NET、HTTP/TLS、可写文件目录。它以 `TcpListener(IPAddress.Loopback, 8765)` 提供 HTML 和固定数据路由，并非 Node/Python 应用。
- 原包只携带两个文件，不包含抓包目录和全部缓存。HTML 的内嵌历史 JSON 提供了部分离线内容，因此“页面有数据”不能证明实时数据依赖已满足。
- 页面加载即启动行情和 ETF 监控：主刷新间隔 300 秒，ETF 监控间隔 60 秒，监控 13 个宽基 ETF；主题、机构页签首次点击才加载。主刷新同时涉及指数、监管、板块和涨跌停，切换到其他页签并不会自动取消这些任务。依据：HTML 954–983、1796、3830、3913、4420。

| 页面功能 | 实际数据路径 | 接入时须保留的语义与限制 |
| --- | --- | --- |
| 头部指数、市场成交额 | 东方财富 `push2delay` / `push2` / `push2his`，`trends2/get`、`clist/get`，JSONP | 上证、深证、创业板以及与上日同时点的成交额比较；属于实时外部依赖 |
| 板块资金流 | 东方财富 `clist/get`、`stock/fflow/kline/get`、`stock/trends2/get` | 行业/概念主力净流入排名、累计曲线和异动；主机失败可直接影响主体页面 |
| 宽基 ETF 承接监控（位于资金流页） | 本地 `/api/nf-minute` → 腾讯分钟数据；东方财富分钟/资金流作补充和降级 | 13 标的；资金流失败时有量价方向推断，原文明确不能确认“国家队”身份，迁移后仍需标为观察信号 |
| 近 3 日资金 | 东方财富板块汇总；本地 `/api/em-history?kind=price3d` 或 `fundDaily` 优先，JSONP 降级 | 三日资金曲线前两日只有收盘累计节点，今日才是分钟累计；不是三天完整资金分钟历史，见 HTML 1174–1187 |
| 涨跌停分析 | 东方财富 `push2ex` 四池：涨停、跌停、炸板、昨日涨停；概念标签另取东方财富；本地 BigAMap 复盘补充强势股 | BigAMap 补充失败时四池可继续显示，强势股部分降级；不同交易日的复盘不会直接混入当日，见 HTML 2704–2734 |
| 异动监管 | 本地 `/api/watch` → 开盘啦；失败/空结果再浏览器 POST 开盘啦，最后用 HTML 静态快照 | 上游可能匿名返回空数据；静态结果必须显著显示业务日期、采集日期和降级原因，见 HTML 2200–2222 |
| 龙虎榜 | HTML 快照 → 浏览器日期缓存 → 开盘啦汇总及逐股明细 → 东方财富 JSONP → 本地服务 bootstrap/代理 | 席位主体、标签、等级、备注部分来自开盘啦快照/响应体，不能假设其他信源字段等价 |
| “开盘啦题材库” | 实际为东方财富概念列表 `fs=m:90+t:3` 和成分股 `fs=b:<板块代码>` | 成分股按行业字段分组；当前不是开盘啦原生题材树，应改称“概念题材库（东方财富）”，见 HTML 3529–3567 |
| 机构多空 | 本地 `/api/bigamap/institutional-long-short` → BigAMap `futures-position-daily` | 股指期货机构/中信持仓；当前必须经过本地代理，不是浏览器直连，见 HTML 3707–3718 |

**本地 HTTP API 清单**

所有路由均由同一 PowerShell 进程串行处理。API 名称只表示当前包的契约，尚未存在于 wolfbot。

| 路由 | 功能、上游与缓存 | 服务源码位置 |
| --- | --- | --- |
| `/`、`/sector_flow_dashboard_optimized.html` | 读取 HTML；带 `lhbDate` 时取龙虎榜并注入 `__LHB_BOOTSTRAP__`，这时访问 HTML 本身也可能触发上游 | PS 965 |
| `/health` | 固定返回 `{"ok":true}`，不检查任何数据源 | PS 982 |
| `/api/watch` | POST `apphwshhq.longhuvip.com/w1/api/index.php`，监管与严重异动两项请求；无服务端 TTL 缓存 | PS 532、556、987 |
| `/api/em-history?kind=...&code=...` | 固定东方财富历史接口；kind 只允许 `price3d` / `fundDaily`，code 有格式检查；无磁盘缓存 | PS 606、993 |
| `/api/stock-kline?code=...&days=...` | 腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`；六位代码，days 限 30–180，默认 90；无磁盘缓存 | PS 725、1001 |
| `/api/nf-minute?code=...` | 腾讯 `web.ifzq.gtimg.cn/appstock/app/minute/query`；六位代码；无磁盘缓存 | PS 792、1009 |
| `/api/bigamap/limit-up-review` | `www.bigamap.cn/api/v1/public/map/limit-up-review`；缓存 120 秒，`refresh=1` 绕过 | PS 685、1016 |
| `/api/bigamap/institutional-long-short` | `www.bigamap.cn/api/v1/public/map/futures-position-daily`；缓存 300 秒，`refresh=1` 绕过 | PS 635、1023 |
| `/api/youzi?date=YYYY-MM-DD`、`/lhb-data.json?date=...` | 龙虎榜日期磁盘缓存 → 本地开盘啦响应体 → 东方财富三类报表分页；日期缓存没有 TTL | PS 403、477、487、1030 |

主要上游实际为东方财富、腾讯、开盘啦、BigAMap。PowerShell 保留了一组同花顺 HTML 解析函数，但当前路由没有调用该入口；`Add-ProxyMetadata` 还硬编码 `upstream="ths"`。不能因此把同花顺列为正在使用的信源，也不能直接相信该 metadata。HTML CSP 允许的 `apphis.longhuvip.com` 亦不能单凭白名单认定存在运行中的请求。

**快照、抓包和缓存的可移植性**

HTML 952 行的 `__LHB_STATIC_DATA__` 含 2026-06-18 的 854 条、2026-06-17 的 1,252 条龙虎榜记录，总计 2,106 条。HTML 953 行的 `__WATCH_STATIC_DATA__` 业务日期为 2026-06-18，采集时间 2026-06-20 20:54，来源标为 `kpl-saz`，含 11 条监管、27 条异动记录。以上由 JSON 解析得出，没有执行 JavaScript，也没有导出明细。

龙虎榜选择内置日期时先使用 HTML 数据，再考虑浏览器缓存；因此不会自然刷新为更完整的历史数据。监管在实时请求失败或为空时落回上述快照。迁移时需要明确 `source`、`tradeDate`、`fetchedAt`、`stale`、`fallbackReason`，不能用页面当前时钟代替数据日期，也不能把历史快照当作实时服务成功。

服务根目录相对于 `start_dashboard.ps1`，其数据目录如下：

| 目录 | 用途 | 本次本机检查 |
| --- | --- | --- |
| `%TEMP%/sector-flow-dashboard-portable/lhb_cache` | `em-<date>.json`、`requests-<day>.txt` | 目录存在，顶层文件数为 0 |
| `%TEMP%/sector-flow-dashboard-portable/bigamap_cache` | 两个 BigAMap JSON 缓存 | 目录存在，顶层文件数为 1；未读取业务内容 |
| `<服务根>/kpl_capture` | 优先读取 `*.php` 扩展名的 JSON 响应体，不执行 PHP | 不存在 |
| `%USERPROFILE%/Desktop/longhu/applhb.longhuvip.com/w1/api` | 上述目录不存在时的历史抓包回退路径 | 不存在 |
| `<服务根>/kpl_capture_decoded/<date>/*.json` | 另一类日期化响应体输入 | 根目录不存在 |

抓包路径来自 PS 7–16、403–474，当前包没有自动抓包/解码刷新这些目录的生产管线。目录缺失不代表整站不可用，但不能承诺新增日期仍有相同质量的开盘啦席位标签。临时目录可被清理，不适合作为生产持久数据目录。

页面 `localStorage` 还保存屏蔽项、龙虎榜日期缓存、请求计数、涨跌停快照、股票概念标签以及最多 200 条 ETF 信号日志；内存 Map 保存若干行情和题材明细。它们按浏览器 origin 存储，不跟随 wolfbot 账号，也不会自然跨设备同步。退出 wolfbot 账号不会清除 8765 页面的历史内容。

**与 wolfbot 当前结构的匹配**

- [package.json](../package.json) 显示 Next 16、React 19、TypeScript；[架构说明](architecture.md) 144 行明确当前为模块化单体，运行态保持 Next.js + Python market-data。HTML 展示功能可逐步组件化，无需增加一个独立生产 PowerShell 服务。
- [PlatformSwitcher.tsx](../src/components/layout/PlatformSwitcher.tsx) 的 `PRODUCTS` 是全局产品入口；[PageHeader.tsx](../src/components/layout/PageHeader.tsx) 已复用该导航。建议新增独立 `/market-dashboard`“行情看板”，归入“研究与交付”，页面使用共享 PageHeader；没有必要塞入项目聊天路由或改根 layout。
- [src/proxy.ts](../src/proxy.ts) 在 auth 开启时做页面与 API 的早期登录拦截。[config/auth.json](../config/auth.json) 默认模式为 disabled，实际运行值可由环境覆盖，本次没有读取私有环境文件、确认生产开关。
- [requireAction](../src/lib/auth/action.ts) 是能力检查边界；[权限目录](../config/access-control.json) 61 行已有 account 范围的 `quant.data.read`，现有 [capabilities API](../src/app/api/quant/capabilities/route.ts) 有调用示范。正式模块应在服务端页面/数据入口执行该检查，API 不能仅依赖导航可见性。没有必须新增权限种类或数据库表的证据。
- [service-catalog.json](../config/service-catalog.json) 的 market-data 默认地址为 `http://127.0.0.1:8000`；Next 的现有数据服务支持 `QUANTPILOT_MARKET_API_URL` / `QUANTPILOT_MARKET_API_BASE_URL`，例如 `src/lib/quant/research-reports.ts:12`。市场服务已有 FastAPI routers/services/providers 和 Redis 缓存，可承接新接口。
- 已有 `/api/v1/research/sector-capital-flow` 是研究股票池的成交额方向代理。`repositories/sector_flow.py:206` 按涨跌方向给成交额加正负号，字段名为 `proxy_net_amount`；它与本包东方财富主力净流入既有覆盖范围差异，也有计算口径差异，不能用它冒充同一个数据源。现有报价/K 线能力可以评估复用，但须对齐分钟、复权、单位和交易日后再替换。
- [发布说明](release-runbook.md) 要求仅 HTTPS 反向代理公开 Web，其他服务置于受控内网。[Web systemd 模板](../deploy/systemd/quantpilot-web.service) 运行 `.next/standalone/server.js`，[market-data 模板](../deploy/systemd/quantpilot-market-data.service) 运行 Python/uv；两者设置 `PrivateTmp`、`ProtectHome`、只读系统目录。Windows 临时路径、桌面抓包和 PowerShell 启动方式与这套 Linux 模板不兼容。模板说明仓库支持的结构，本次没有检查线上机器是否完全按模板配置。
- [docker-compose.yml](../docker-compose.yml) 当前编排数据库、Redis、ClickHouse 与观测组件，没有编排这个 CMD 服务。Electron 在 `electron/main.js:155` 开启 context isolation、关闭 node integration；它会启动/加载本地 Next 服务，但没有自动管理 8765。`package.json` 的打包清单也没有包含这份 extend 包。

**方案 A：最小本地嵌入，适合同机验证**

新页面用 iframe 加载现有 `http://127.0.0.1:8765/`，保持 HTML 由 8765 原站提供。wolfbot 展示统一导航、加载状态、重试和“在独立页面打开”的用户入口；本次不实际创建页面或打开该入口。建议显式标注“本机行情看板”，默认仅在启用的本地模式可用。

浏览器直接请求 8765，且必须与该 Windows 服务处于同一台机器。已存在服务的健康检查返回 HTTP 200、`{"ok":true}`、`Access-Control-Allow-Origin: *`；这只验证服务响应，不验证行情、完整图表或第三方数据可用性。

后续 iframe 可从 `sandbox="allow-scripts allow-same-origin"`、`referrerPolicy="no-referrer"` 起步：脚本和 origin 存储是现页面的实际需求，不开放顶层导航、弹窗或其他多余能力。8765 与 wolfbot 的不同端口形成不同 origin，隔离 DOM 和 localStorage；但 Cookie 不按端口隔离，不能把“不同端口”视为完整凭据边界。若两者都使用相同 hostname，Cookie 是否携带仍受 domain/path/SameSite 等规则影响，不能声称不会传给 8765。正式隔离需要独立 Cookie 边界或移除这类远程脚本。

客户端可以超时请求 `/health`，只表示“本地服务可达”；iframe 的 load 事件也不表示所有数据成功。不要让 Next 服务器代为探测后就宣布访问者本机的服务健康。导航离开时卸载 iframe；后续验证隐藏页面是否应暂停定时请求。

以下地址行为决定了为什么不建议直接把原 HTML 复制到 `public/`：

| 页面实际地址 | HTML `localServiceUrl()` 的结果 | 后果 |
| --- | --- | --- |
| iframe 内 `http://127.0.0.1:8765/` | 使用当前 origin 8765 | 保留现有本地代理和根路径 bootstrap 行为 |
| `http://localhost:3000/...` 或 `http://127.0.0.1:3000/...` | 使用当前 origin 3000 | 请求 `/api/watch`、`/api/nf-minute` 等落到没有这些路由的 Next 应用 |
| `https://quantpilot.example/...` 或局域网 IP 页面 | 回退到 `http://127.0.0.1:8765` | 请求访问者电脑的服务；不会访问部署服务器上的 8765 |
| Next 服务器代理到 `127.0.0.1:8765` | 指 Next 所在主机/网络命名空间 | 容器内还可能指容器自身，同样无法访问任意访问者电脑 |

依据 HTML 2829–2832。此外，HTML 3473–3475 在龙虎榜直连失败时执行 `location.href='/?lhbDate=...'`，由 PS 965–977 注入数据；原 HTML 放进 Next 子路径或反向代理前缀后，会跳到该 origin 根页面。完整迁移必须移除此隐式导航或实现显式数据加载。

wolfbot 的 `next.config.js` 全站设置 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`，含义是禁止 wolfbot 响应被其他页面嵌入，不是禁止 wolfbot 嵌入 8765；没有理由为方案 A 全局关闭这些保护。反之，若把 HTML 放在 wolfbot 自己的路径再 iframe，它作为子响应也会收到禁止被嵌入的头，需要精确设计该子路由，不能照搬方案 A。参见 [MDN frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)。

远程 HTTPS 页面访问 HTTP loopback 还涉及浏览器 Local Network Access、权限委派和混合内容规则，不能保证各浏览器都成功，也不能笼统说所有浏览器必然因 mixed content 拦截。Chrome 已引入包含 loopback 和子框架导航的本地网络权限机制，见 [Chrome 官方说明](https://developer.chrome.com/blog/local-network-access)。本地 iframe 可行是架构判断，本次未验证具体浏览器组合。

**方案 B：正式平台模块，推荐作为最终形态**

请求链为 `浏览器 /market-dashboard → Next /api/quant/market-dashboard/*（quant.data.read）→ Python /api/v1/market-dashboard/* → 固定 provider 与共享缓存`。浏览器只使用 wolfbot API，不接触 PowerShell、桌面抓包路径、市场服务管理令牌或任意代理 URL。

1. 先迁移数据适配层：东方财富板块/指数/涨停池，腾讯分钟/K 线，BigAMap 复盘/机构多空，开盘啦监管/龙虎榜；复用已存在且口径一致的能力。每个上游配置固定主机与路径，参数按 schema 校验，设超时、分页上限、并发和共享刷新限额。
2. API 返回统一数据日期、更新时间、单位、真实来源、缓存命中、部分失败/过期状态；保留三日资金节点和 ETF 量价推断的语义。由服务端缓存消除多用户重复拉取；冷热数据 TTL 分开，禁止任意客户端用 `refresh=1` 无限绕过缓存。
3. 拆分 React 展示组件，保留七页签及有价值的交互；CSS 收敛到组件作用域，避免原页面全局选择器污染主站。原生 SVG 算法可选择性复用，不必为了迁移强换图表库。
4. 原 HTML 快照从默认生产资源中移除。确需保留历史数据时，作为有来源、有日期且经过内容筛选的数据集进入专门存储；不复制桌面/临时抓包目录，不导入原始抓包头、账号信息或无关响应。这个数据操作不包含在本次评估内。
5. 按现有 Linux/Python 服务部署，复用其日志、ready 和 Redis。上游失效时页面呈现局部降级，不让“机构多空”之类单项失败使全站登录或主站就绪失败。

为验证数据接口，也可以短期保留经过提取、修改地址与清理快照的 HTML 作为兼容 UI；但代理一个原始根页面不是完整兼容层。需同时处理 CSP 的 `connect-src`（原策略没有允许远程主站同源 API）、根路径跳转、鉴权、JSONP 脚本来源及缓存语义；这条过渡路线的额外工作必须计入估算。

**具体风险及处理边界**

| 风险 | 代码依据与影响 | 推荐边界 |
| --- | --- | --- |
| 本地服务绕开 wolfbot 鉴权 | PS 30–46 对所有响应加 `Access-Control-Allow-Origin: *`；请求循环只解析请求行，没有用户、Origin/Host 校验，只有 GET，其他方法 405 | 维持 loopback 仅作本机工具；正式服务走 Next 能力检查，Python 置于受控内网。CORS 不是用户鉴权，不将 8765 改为公网监听 |
| 内容暴露 | HTML 直接包含龙虎榜及监管历史 JSON；本地代理可返回捕获的席位标签；前端源码与浏览器缓存可被收到它的使用者读取 | 不把原包/快照作为默认公开静态资源；确认接收对象和内容范围。当前 Next proxy 并非统一放行所有 public 文件，不能简单宣称“放 public 就一定匿名可读”，但仍存在打包分发、auth disabled 和静态托管绕过应用鉴权的暴露面 |
| JSONP 信任边界 | HTML 1088 动态插入第三方 script，它以该文档的权限执行；原始脚本大量写 DOM | iframe 只隔离到独立 origin；直接注入同源 React 页面会扩大到 wolfbot origin。正式迁移从服务器取 JSON，审查 HTML 输出与转义；不声称本次已完成全面 XSS 审计 |
| 伪全局限流 | PS 514 的 990 次/日只对龙虎榜磁盘缓存未命中逻辑计一次；一次会调用多类分页报表 | 不把 990 当真实上游 HTTP 请求总额；浏览器 JSONP、开盘啦逐股请求、BigAMap/监管/分钟请求都不受它覆盖 |
| 单线程阻塞与负载 | PS 933 起一个 `AcceptTcpClient` 循环同步处理；上游可等 15–30 秒且可能分页；HTML 龙虎榜明细并发 6、概念补全并发最多 8 | 当前适合单用户工具；多人服务需要异步 I/O、请求合并、并发限制、隔离超时。API 500 不应透出文件路径或内部错误原文 |
| 来源与数据口径误导 | “开盘啦题材库”实际用东方财富，`_proxy.upstream` 错写 ths；资金代理、收盘节点与分钟流、静态与实时混存 | 来源和口径作为可验证字段；源不可用时不换一个含义不同的指标假装恢复 |
| 上游持续性与再分发 | 代码调用外部网站/App 接口，不含稳定接口或再分发承诺的证据；历史快照不能证明当前接口正常 | 本次技术可行性不等于上游稳定性/再分发已确认。后续只对实际拟交付的数据源核对使用条件和可用性，不默认需要付费，也不默认获得转发权 |
| 跨环境持久化 | 临时目录、桌面目录、浏览器 origin 存储都不会跟随服务器部署/用户账号 | 共享行情缓存迁 Redis；需要用户私有偏好的时候再设计账号存储，不先增加无必要的数据表 |

关于 iframe 的脚本、同源和存储权限，可参见 [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)。不同 origin 的 sandbox iframe 可以保留必要权限；若后来改成主站同源页面，不能继续把 `allow-scripts allow-same-origin` 当成有效的同源安全隔离。

**未来精确改动位置，均未实施**

| 阶段 | 文件 | 预期改动 |
| --- | --- | --- |
| A | `src/app/market-dashboard/page.tsx`（新增） | 路由、页面元信息、显式本地模式及适用的服务端能力检查 |
| A | `src/app/market-dashboard/MarketDashboardClient.tsx`（新增） | PageHeader、固定本机 iframe、超时可达状态与重试；清楚标注外部本地服务边界 |
| A | `src/components/layout/PlatformSwitcher.tsx` | PRODUCTS 增加“行情看板”入口 |
| A | `config/module-boundaries.json` | 将 `src/app/market-dashboard/**` 纳入现有 quant-core 路径归属 |
| A | `.env.example`、`docs/configuration.md` | 如采用显式开关，记录新的本地模式开关；默认不向远程部署开放本机依赖 |
| B | `src/app/api/quant/market-dashboard/[resource]/route.ts`（新增） | 固定 resource 白名单、`requireAction('quant.data.read')`、参数/响应校验与超时；不是任意 URL 代理 |
| B | `src/lib/quant/market-dashboard.ts`、`src/lib/quant/market-dashboard-types.ts`（新增） | 服务端 API 编排与类型；遵循现有 market API 环境地址，不将管理令牌发往浏览器 |
| B | `src/app/market-dashboard/components/SectorFlowPanel.tsx`、`ThreeDayFlowPanel.tsx`、`LimitAnalysisPanel.tsx`、`RegulatoryWatchPanel.tsx`、`DragonTigerPanel.tsx`、`ThemeLibraryPanel.tsx`、`InstitutionPositionsPanel.tsx`、`MarketOverview.tsx`、`EtfWatchPanel.tsx`（新增） | 逐项迁移七页签、头部和 ETF 监控；文件名为建议设计 |
| B | `services/market-data/src/quantpilot_market_data/routers/market_dashboard.py`、`services/market-data/src/quantpilot_market_data/services/market_dashboard.py`（新增） | 受控的 `/api/v1/market-dashboard/*` 数据契约与缓存编排 |
| B | `services/market-data/src/quantpilot_market_data/providers/eastmoney.py`（扩展）、`tencent.py`、`bigamap.py`、`kaipanla.py`（按缺口新增） | 可审查的固定上游适配，复用已有 provider，不搬运 CMD 执行器 |
| B | `services/market-data/src/quantpilot_market_data/api.py`、`models.py`、`cache.py` | 注册 router、响应模型；复用缓存，只有发现必要缺口时才改 cache |
| B | `config/service-catalog.json`、`config/module-boundaries.json`、`services/market-data/README.md`、`docs/configuration.md` | 登记能力、目录归属、API、开关、TTL 和降级约定 |
| B 验证 | `src/app/api/quant/market-dashboard/[resource]/route.test.ts`、`services/market-data/tests/test_market_dashboard.py`（新增） | 未登录/无权限、参数边界、统一字段、缓存、超时、部分失败和日期语义；采用 fixture，避免测试轰击上游 |
| 条件项 | `next.config.js` | 仅在另选同源 iframe/专用内容路由时需要有针对性地调整策略；方案 A 和原生 React 方案 B 不要求全局放开 frame-ancestors |
| 条件项 | `electron/main.js`、`package.json` | 只有明确要分发并自动管理本地伴随服务时再评估；当前最小方案不包含自动启动或安装器集成 |

本地 A 无需修改 Prisma/SQL、现有 market-data、生产 systemd 或 Docker。正式 B 若只做查询和共享缓存，第一版亦无必然的数据库迁移；历史归档和账号偏好可作为独立后续需求。

**工作量与后续验收建议**

估算前提：一名熟悉此仓库的工程师，既有服务可用；工期是代码规模估计，尚未经浏览器验证和真实上游响应验证。

| 目标 | 估算 | 验收界限 |
| --- | --- | --- |
| 同机入口与 iframe 原型 | 0.5–1 人日；考虑登录、服务不可达和浏览器验证约 1–2 人日 | 导航、嵌入、8765 停止/恢复提示、权限配置、根路径龙虎榜回退、存储和样式隔离；不能声称面向远程多用户就绪 |
| 正式基础版：概览、板块、近三日、涨跌停 | 约 5–8 人日 | 同源鉴权 API、共享缓存、字段/交易日校验、远程浏览器不请求 loopback、上游局部失败有明确反馈 |
| 七页签与 ETF 监控达到可维护的功能覆盖 | 总计约 10–15 人日，不是另加 10–15 天 | 加入监管、龙虎榜、机构、题材及信号语义；历史数据内容确认、第三方限制和特殊字段缺失可能增加时间 |

后续实际实现时，用固定小样本验证原脚本与新适配器的金额单位、日期、涨停晋级、龙虎榜买卖/去重、复权和字段映射；用 fixture 验证限流、缓存合并与失效，不自动全量刷新上游。浏览器验收同时覆盖本机与远程 HTTPS、普通用户与权限拒绝、上游超时/空结果、历史快照过期、离开页面停止轮询。

本次可以确认的是代码可拆解、接口边界可迁移、现有导航和服务架构有明确接入点，以及 8765 的轻量健康响应正常。尚未确认的是七页签今天的真实数据完整性、生产主机出网条件、具体浏览器的 iframe 权限行为和上游持续可用性；这些验证应属于后续获授权的实现阶段。

# S20 完整发布门：35 个失败用例清单

本表逐项对应 Windows 独立 checkout 的 `s20-release-03.log`：21 个测试文件、35 个用例失败，1418 passed / 71 skipped；发布门前 17 项通过。原日志 SHA-256 为 `c32ed342f47e627197157fcb7eaa4f9025204d33ebab4b5cc448619fd9c5e84b`，源码身份见 `S20/validation-snapshot-v3.json`。这是历史实跑结果，本次只核对日志、源码和字符串副本，没有重跑完整发布门。

本次清单与无模型字节核对保存于 `data/research-agent-upgrade/evidence/S20/failure-inventory-20261020-01/inventory.json`，SHA-256 `4a18962fd8df63e8432107e9b5b3da29699db79b3c6c8c988e4ce053de1392e0`。原失败日志及验证快照保持不变。

## 数量与含义（原清单分类）

以下保留整理原日志时的分类和已知边界；2026-10-20 的进一步根因定位见本文末尾“根因补充”。历史失败数量不因定向复验通过而改写。

| 类别 | 数量 | 已证实的范围 |
| --- | --- | --- |
| 符号链接创建权限 | 19 | fs.symlink 在测试准备阶段返回 EPERM；相应安全断言尚未执行 |
| 路径与平台分支 | 9 | POSIX fixture、路径分隔符、Linux 沙箱/监听假设及脚本可执行性前置错误；仍需各自复验 |
| CRLF / LF | 3 | SQL marker / regex 与生成组件逐字比较；对原隔离副本仅做字符串归一化即可定位差异 |
| 旧品牌断言 | 1 | 正则仍寻找 QuantPilot，当前输出使用 wolfbot |
| Skill 上下文超预算 | 1 | 5026 字符超过 5000；增长原因尚未定位 |
| 测试超时 | 2 | 两个用例达到 5000ms 上限；尚未定位阻塞或资源竞争 |

19 项权限错误不能解读为已经发现 19 个越权漏洞，也不等于安全测试通过。其余项目同样不能统一归为“换 Linux 就能通过”；特别是旧断言、Skill 预算和超时需要单独核对。

## 完整逐项清单

编号保持原日志顺序；源码链接标出日志定位行，若代码后续改动，以保存的验证版本为准。

| # | 测试文件 / 日志定位行 | 要验证的行为 | 实际失败 |
| --- | --- | --- | --- |
| 1 | [src/lib/agent/framework-identity.test.ts:94](../../../src/lib/agent/framework-identity.test.ts) | 未跟踪文件的内容变化须改变框架指纹 | 改写 fixture 内容后 hash 仍相同。fixture 的 Map 键固定为 /repo/...，实现经 path.resolve 后在 Windows 得到带盘符路径，mock 回退为空内容。 |
| 2 | [src/lib/data-agent/workspace-files.test.ts:35](../../../src/lib/data-agent/workspace-files.test.ts) | 拒绝通过嵌套符号链接写出工作区 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 3 | [src/lib/data-agent/workspace-path.test.ts:58](../../../src/lib/data-agent/workspace-path.test.ts) | 拒绝已存在目标与符号链接工作区 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 4 | [src/lib/data-agent/workspace-path.test.ts:69](../../../src/lib/data-agent/workspace-path.test.ts) | 拒绝把符号链接设为工作区根目录 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 5 | [src/lib/quota/defaults.test.ts:32](../../../src/lib/quota/defaults.test.ts) | 迁移权限授权与能力目录保持一致 | 找不到 permission_profile_member_default 的 migration grant block；原隔离副本使用 CRLF，而测试 marker 固定 LF。只对副本字符串归一化后可找到。 |
| 6 | [src/lib/quota/defaults.test.ts:53](../../../src/lib/quota/defaults.test.ts) | 迁移配额种子与运行时目录保持一致 | 找不到 migration quota rule seed block；匹配式要求分号后两个 LF。原副本归一化后可匹配，尚不代表整个配额内容断言已通过。 |
| 7 | [src/lib/serializers/chat.test.ts:53](../../../src/lib/serializers/chat.test.ts) | 超长工具输出只截断一次并保留头尾 | match(/QuantPilot 已截断/g) 返回 null；当前提示为“wolfbot 已截断”。失败位于旧品牌计数断言。 |
| 8 | [src/lib/server/image-assets.test.ts:46](../../../src/lib/server/image-assets.test.ts) | 图片配置上限和路径穿越约束 | 预期路径含 project-safe/assets/logo.png，实际路径用 Windows 反斜杠；失败位于字符串包含断言。 |
| 9 | [src/lib/server/image-assets.test.ts:65](../../../src/lib/server/image-assets.test.ts) | 图片只接受当前项目 assets 内的普通文件 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 10 | [src/lib/security/generated-project-sandbox.test.ts:22](../../../src/lib/security/generated-project-sandbox.test.ts) | 沙箱环境变量白名单与凭据隔离 | QUANTPILOT_WORKSPACE_ROOT 预期 /tmp/project，实际经 Windows resolve 变为带盘符路径；日志没有显示密钥泄漏。 |
| 11 | [src/lib/security/generated-project-sandbox.test.ts:59](../../../src/lib/security/generated-project-sandbox.test.ts) | 直接执行必须具备成对的显式例外开关 | 预期 explicit unsafe override，实际先报需要 Linux namespace sandbox；尚未执行到预期错误分支。 |
| 12 | [src/lib/services/file-browser.test.ts:81](../../../src/lib/services/file-browser.test.ts) | 文件浏览器隐藏凭据并拒绝通用读写 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 13 | [src/lib/services/pi-agent-provenance.test.ts:56](../../../src/lib/services/pi-agent-provenance.test.ts) | 工作区身份依据 namespace 与真实路径 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 14 | [src/lib/services/preview.test.ts:209](../../../src/lib/services/preview.test.ts) | 并发启动预览只创建一个进程 | QUANTPILOT_SANDBOX_PREVIEW_SOCKET 为 undefined，无法匹配预期 Unix Socket 路径。 |
| 15 | [src/lib/services/preview.test.ts:262](../../../src/lib/services/preview.test.ts) | 安装生成依赖时禁用宿主生命周期脚本 | mock 预期执行 npm，实际执行 npm.cmd，并出现 Windows 分支的 env/shell 参数差异；原日志仍含 --ignore-scripts，不能据此认定生命周期脚本已被执行。 |
| 16 | [src/lib/services/preview.test.ts:423](../../../src/lib/services/preview.test.ts) | 一次监听表快照发现已有项目预览 | 预期接管 4173 端口，实际返回 3001。fixture 使用 Linux ss 与 /proc 进程目录，需核对 Windows 分支的发现流程。 |
| 17 | [src/lib/services/preview.test.ts:468](../../../src/lib/services/preview.test.ts) | 接管生成 chroot 内的已有预览 | 预期接管 chroot 中的 4173 端口，实际返回 3002。fixture 使用 Linux /proc 与生成 chroot 路径，需 Linux 复验。 |
| 18 | [src/lib/utils/chart-panel.test.ts:23](../../../src/lib/utils/chart-panel.test.ts) | 首根可见 K 线使用完整 233 日历史 | 失败在最终组件源码逐字相等断言，前面的 MA233 数值断言已执行。隔离副本 PriceVolumeChart.tsx 有 232 处 CRLF；双方归一化 LF 后相等。 |
| 19 | [src/lib/agent/runtime/workspace-mutation-journal.test.ts:118](../../../src/lib/agent/runtime/workspace-mutation-journal.test.ts) | 拒绝符号链接形式的变更日志根目录 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 20 | [src/lib/agent/pi/run-engine.test.ts:139](../../../src/lib/agent/pi/run-engine.test.ts) | 真实 PI 多轮工具循环及用量顺序 | Test timed out in 5000ms；日志不足以区分运行阻塞与资源竞争，需要保留相同断言定位耗时。 |
| 21 | [src/lib/agent/skills/compiler.test.ts:170](../../../src/lib/agent/skills/compiler.test.ts) | 附件 Skill 独立激活并拒绝不兼容工具 | 原子 Skill 上下文为 5026 字符，超过冻结的 5000 字符预算 26 字符；编译器拒绝截断关键内容。尚未确定增长来自何处。 |
| 22 | [src/lib/agent/skills/compiler.test.ts:290](../../../src/lib/agent/skills/compiler.test.ts) | 保留完整参考镜像并按阶段限制运行胶囊 | Test timed out in 5000ms；完整参考镜像安装/阶段胶囊用例超时，不能直接提高超时后算修复。 |
| 23 | [src/lib/agent/skills/compiler.test.ts:358](../../../src/lib/agent/skills/compiler.test.ts) | 安装前拒绝包内符号链接 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 24 | [src/lib/agent/skills/compiler.test.ts:416](../../../src/lib/agent/skills/compiler.test.ts) | 拒绝内容树偏离 sourceSha256 的 Skill 包 | 预期报“安装包内容与 source lock 不一致”，实际先报 scripts/normalize_extraction.py 不可执行；前置校验遮住了内容漂移反例，须核对平台执行权限。 |
| 25 | [src/lib/agent/tools/filesystem.test.ts:180](../../../src/lib/agent/tools/filesystem.test.ts) | 文件工具拒绝经符号链接越界读写 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 26 | [src/lib/agent/tools/filesystem.test.ts:207](../../../src/lib/agent/tools/filesystem.test.ts) | 拒绝通过别名写入 .data-agent | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 27 | [src/lib/agent/tools/filesystem.test.ts:323](../../../src/lib/agent/tools/filesystem.test.ts) | 拒绝根执行钩子及内部符号链接别名 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 28 | [src/lib/agent/tools/structured-read.test.ts:461](../../../src/lib/agent/tools/structured-read.test.ts) | 结构化读取拒绝穿越、链接和无效输入 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 29 | [src/lib/agent/mission/evidence-verifier.test.ts:426](../../../src/lib/agent/mission/evidence-verifier.test.ts) | 证据验证器拒绝验收页面经链接逃逸 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 30 | [src/lib/domains/finance/agent-tools/dashboard-contract.test.ts:256](../../../src/lib/domains/finance/agent-tools/dashboard-contract.test.ts) | 看板合同固定路径不能经链接越界 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 31 | [src/lib/domains/finance/agent-tools/dashboard-spec.test.ts:790](../../../src/lib/domains/finance/agent-tools/dashboard-spec.test.ts) | 看板输出目录为链接时拒绝写入 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 32 | [src/lib/domains/finance/agent-tools/image-extraction.test.ts:131](../../../src/lib/domains/finance/agent-tools/image-extraction.test.ts) | 图片抽取拒绝绝对路径和链接逃逸 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 33 | [src/app/api/projects/[project_id]/artifact/route.test.ts:27](../../../src/app/api/projects/[project_id]/artifact/route.test.ts) | 产物 API 对环境文件和凭据返回 404 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 34 | [src/app/api/projects/[project_id]/artifact/route.test.ts:27](../../../src/app/api/projects/[project_id]/artifact/route.test.ts) | 产物 API 继续提供非敏感生成文件 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |
| 35 | [src/app/api/projects/[project_id]/artifact/route.test.ts:27](../../../src/app/api/projects/[project_id]/artifact/route.test.ts) | 产物 API 拒绝通过链接绕过敏感路径策略 | 测试准备阶段 fs.symlink 返回 EPERM，尚未进入对应的安全断言。 |

## 原始测试名称

- 1：`PI Agent framework identity > binds untracked paths and contents deterministically within a hard budget`（原日志第 253 行）。
- 2：`atomic workspace files > rejects a nested symlink escape`（原日志第 265 行）。
- 3：`managed Data Agent workspaces > rejects existing targets and symlink workspaces`（原日志第 277 行）。
- 4：`managed Data Agent workspaces > rejects a symlink configured as the managed projects root`（原日志第 289 行）。
- 5：`built-in access-control defaults > keeps migration permission grants synchronized with the capability catalog`（原日志第 301 行）。
- 6：`built-in access-control defaults > keeps all migration quota rules synchronized with the runtime catalog`（原日志第 314 行）。
- 7：`tool output serialization > compacts a legacy oversized tool result once with both head and tail`（原日志第 327 行）。
- 8：`image asset validation > bounds configuration and rejects traversal filenames`（原日志第 339 行）。
- 9：`image asset validation > accepts only regular files from the current project assets directory`（原日志第 355 行）。
- 10：`generated project sandbox > uses an explicit minimal environment without platform secrets`（原日志第 367 行）。
- 11：`generated project sandbox > requires the paired explicit override before running a trusted command directly`（原日志第 394 行）。
- 12：`file browser workspace mutation coordination > hides credential files and rejects generic read or write access`（原日志第 410 行）。
- 13：`PI Agent provenance > derives workspace identity from namespace and canonical realpath, not contents`（原日志第 422 行）。
- 14：`PreviewManager start concurrency > coalesces concurrent starts into one process and one ready result`（原日志第 434 行）。
- 15：`PreviewManager start concurrency > installs generated dependencies without host lifecycle scripts`（原日志第 446 行）。
- 16：`PreviewManager start concurrency > discovers an existing project preview with one listener-table snapshot`（原日志第 610 行）。
- 17：`PreviewManager start concurrency > adopts a project listener whose cwd is inside the generated chroot`（原日志第 635 行）。
- 18：`interactive chart data > uses 233 full-history observations even for the first visible candle`（原日志第 660 行）。
- 19：`PI Agent durable workspace mutation journal > refuses a symlinked framework journal root`（原日志第 1142 行）。
- 20：`PiAgentRunEngine > lets PI own a real multi-turn tool loop and preserves ordered usage`（原日志第 1154 行）。
- 21：`compilePiAgentSkills > activates attachment skills independently of capability and rejects incompatible tools`（原日志第 1167 行）。
- 22：`compilePiAgentSkills > keeps the reference mirror complete while runtime capsules stay phase-scoped`（原日志第 1180 行）。
- 23：`compilePiAgentSkills > rejects a package-only Skill containing an internal symlink before workspace installation`（原日志第 1193 行）。
- 24：`compilePiAgentSkills > rejects a package-only Skill whose content tree drifts from sourceSha256`（原日志第 1205 行）。
- 25：`PI Agent typed filesystem tools > rejects read and write escapes through symbolic links`（原日志第 1221 行）。
- 26：`PI Agent typed filesystem tools > detects a writable-looking symlink alias that resolves into .data-agent`（原日志第 1233 行）。
- 27：`PI Agent typed filesystem tools > does not allow root executable hooks or internal symlink aliases by default`（原日志第 1245 行）。
- 28：`PI Agent structured read tools > fails closed for traversal, escaping symlinks, invalid JSON, and JSON text queries`（原日志第 1257 行）。
- 29：`PI Agent EvidenceVerifier > fails closed when an acceptance-surface symlink escapes the workspace`（原日志第 1269 行）。
- 30：`inspect_dashboard_contract tool > fails closed when a fixed contract path escapes through a symbolic link`（原日志第 1281 行）。
- 31：`apply_dashboard_spec tool > denies a symlinked output directory without touching the target`（原日志第 1293 行）。
- 32：`PI Agent image extraction tool > rejects direct paths and symlinks that escape the workspace`（原日志第 1305 行）。
- 33：`project artifact file policy > returns not found for environment and credential paths`（原日志第 1317 行）。
- 34：`project artifact file policy > continues serving non-sensitive generated artifacts`（原日志第 1329 行）。
- 35：`project artifact file policy > cannot bypass the sensitive path policy through a symlink`（原日志第 1341 行）。

## 本次确认了什么

SQL 副本的权限 marker、配额正则在原始 CRLF 上均未命中，归一化为 LF 后均命中；这只定位文本解析问题，没有宣称迁移内容的全部断言通过。图表副本含 232 处 CRLF，与源模板拼接结果逐字不同；双方归一化 LF 后相同。MA233 用例实际失败在最终源码相等断言，不能把它写成均线算法算错。

同样，依赖安装的失败日志仍包含 `--ignore-scripts`，当前证据只能说明命令与参数的预期不匹配，不能写成已经执行了宿主生命周期脚本。沙箱环境断言的可见差异是 `QUANTPILOT_WORKSPACE_ROOT` 的路径形式，不能据此声称平台密钥泄漏。

后续先用支持真实符号链接和 Linux namespace 的隔离环境复现，保留原门禁和本清单，再按具体反例修复。Skill 5026 / 5000 和两个超时须定位原因，不通过提高预算、取消保护或跳过安全用例制造通过。此处不展开用户已暂缓的 Node 锁文件与 Python 依赖审计。

当前整体状态与下一动作见 [进度](progress.md)，演示和已通过项见 [交付材料](delivery.md)。

## 2026-10-20 根因补充

本轮分析起点为 `ea48ab49e0dc369ce01db4be7ccde9c8d084767c`。重新核对原日志 hash、当前源码与原隔离 checkout，并实跑四个有待归因的用例和无模型探针。产品代码、测试断言、5000 字符门槛及 5 秒超时均未修改。

目前可将原 35 项分为：32 项环境或测试适配问题，1 项 Skill 编译器的跨平台文本处理缺陷，2 项尚未完全归因的历史超时。这是根因归类，不是 32 项豁免；其中 19 项安全断言仍须在能够建立真实符号链接的环境执行。上轮 review 的三个产品问题不在这 35 项清单内，必须另外修复和回归。

### 逐类判断与处理

| 原编号 | 根因和证据 | 性质 | 正确处理 |
| --- | --- | --- | --- |
| 2—4、9、12—13、19、23、25—35（19 项） | 测试先创建真实链接作为越界输入；Windows 当前进程没有完成该操作的权限，直接 EPERM。本轮在新临时目录创建普通文件链接也得到 EPERM。 | 环境前置条件不满足，测试没有到达目标断言；不能推导存在 19 个越权漏洞，也不能推导防护通过。 | 在支持真实链接的 Linux 文件系统运行原安全反例；本机测试可增加明确能力预检。不得用普通文件替换链接或以跳过当作发布通过。 |
| 1 | 测试 Map 的键为 `/repo/...`，实现通过系统 `path.resolve` 得到 Windows 盘符与分隔符；mock 查不到键后返回空 Buffer，修改 fixture 也一直读到空内容。 | 测试数据构造错误，当前证据不支持哈希算法忽略真实文件变化。 | fixture 和被测实现采用相同的规范绝对路径，未知路径应让 mock 报错；保留“内容改变必须改变指纹”的断言。 |
| 8、10 | #8 预期 `/` 而实现返回 Windows 文件路径；#10 预期 `/tmp/project` 而实现先执行 Windows resolve。 | 路径表示断言不跨平台；#10 的失败不能证明凭据泄漏。 | 用 `path.join/resolve` 构造文件路径预期；保留凭据不得出现在环境中的独立断言。文件路径与 URL 路径分别处理。 |
| 11 | 实现首先判断 Linux 支持；Windows 在检查 Linux 禁用开关之前便拒绝执行，错误消息与测试期待的 Linux 分支不同。 | 平台分支测试错误；当前运行是拒绝执行，没有出现放行。 | 按平台验证其公开合同：Linux 验证显式例外开关，其他平台验证默认拒绝；不取消沙箱限制来迎合消息断言。 |
| 14 | Unix Socket 环境变量只在 `process.platform === 'linux'` 且启用网络 namespace 时设置，Windows 本来不创建该 Socket。 | 测试把 Linux 网络实现绑定在通用并发用例里。 | 将“并发只启动一次”与“Linux Socket 配置”拆分验证，保留两个目标。 |
| 15 | Windows 实际运行 `npm.cmd` 并使用对应 shell/env；测试固定期待 `npm`。原命令仍含 `--ignore-scripts`。 | 平台命令断言不匹配，未证明安装时执行了宿主脚本。 | 平台适配命令预期，继续明确验证 `--ignore-scripts` 与环境隔离。 |
| 16、17 | `findListeningPorts` 在 Windows 直接返回空集合，PID/路径核对也没有 Windows 接管实现；测试却注入 Linux `ss` 和 `/proc` 数据并期待接管 4173。 | 已知平台能力边界与 fixture 不一致。Windows 采用新端口启动，Linux chroot 接管尚须在 Linux 复验。 | 给 Linux 接管行为单独测试，并验证 Windows 的安全降级；若产品要求 Windows 同等接管能力，则是另一个明确实现需求。 |
| 24 | 原 Skill tgz 中脚本 mode=755；Windows 解压到文件系统后 mode=666，测试再次 `tar.c` 写入的 mode=644。编译器检查可执行位先于检查内容树 hash。 | 篡改 fixture 同时引入了不打算测试的权限缺陷，遮住目标分支；编译器拒绝坏包是正确行为。 | 构造篡改包时保留原 archive mode，单独改变内容与包 hash，使 source lock 不一致成为唯一目标错误；保留权限检查。 |
| 5、6、18 | #5/#6 以固定 LF marker/regex 解析 SQL；#18 比较 LF 模板和 CRLF 文件。原字节归一化已定位差异。#18 的 MA233 算术断言在源码对比前已经通过。 | 测试比较了不应决定语义的换行表示；未证明迁移授权、配额或均线计算错误。 | 在测试读入边界统一文本换行或声明所需 Git eol；随后运行完整内容断言，不能只证明 marker 找到就宣称迁移合同通过。 |
| 7 | 产品已改名 wolfbot，实际截断标记使用“wolfbot 已截断”；测试仍用 `QuantPilot 已截断` 统计次数。 | 旧品牌断言未同步。 | 保留“仅截断一次、保留头尾、字符上限”的语义断言，更新品牌预期。无需改回产品名称。 |
| 21 | Skill 资源在完整性 hash 阶段统一 LF，运行上下文读取却保留 CRLF；同一合格资源因 checkout 换行不同多出 40 字符，5026 超过 5000。 | 确定的编译器跨平台逻辑缺陷，质量门正确发现预算冲突；不是模型 Token 用量，也不是必须增加预算。 | 编译 resource 前采用与 hash 一致的文本规范化，保留原子段落和 5000 上限；补 LF/CRLF 等价回归。 |
| 20、22 | 原全套 250 文件并行测试中超过 5000ms；本轮四用例定向串行时分别约 1669.7ms、660.0ms，通过原断言和原 5 秒限制。 | 超时原因尚未完全锁定；并行资源竞争、PI 首次动态导入、多个 Skill 的校验/复制开销是具体候选原因，尚无 CPU/I/O 时间线证明唯一根因。 | 同版本按单文件与有界并发对照，记录冷启动/导入/文件 I/O 分段耗时；查明是否资源争用或间歇性阻塞，再调整 runner 或实现。不能把本轮一次通过写成历史超时已修复。 |

### Skill 预算反例的进一步证明

原组合为 stock_diagnosis / data-preparation，额外激活 image-extraction、data-quality，排除 quant-symbol-resolver。原编译器在预算 5000 下仍报 5026。诊断测量得到 systemContext=837、taskContext=4189，其中实际进入上下文的 CRLF 为 40 处；统一 LF 后总长 4986。

另开独立进程，仅在读取 `dashboard-visualization/references/visual_judgement.md` 时规范换行，未写回文件、未修改 lock，使用原 5000 预算调用真实编译函数，成功返回 4986。完整源文件有 80 处 CRLF，阶段筛选只把其中 40 处带入上下文。hash 校验本来就使用规范换行，因此此差异与原文变更、Skill 增长或伪造 hash 无关。

诊断中曾用 6000 的只读测量参数取得失败输出的组成，随后使用原 5000 参数证明规范化的效果；这不构成修改验收门槛，原测试仍失败，产品修复尚未实施。

### 与上轮三个产品问题的关系

R1 证券解析是接口格式合同不一致：用户输入名称/六位代码，工作台保存带交易所后缀的规范身份，创建 API 却把规范身份原样交给只接受普通查询的解析器。身份拒绝本身是防护结果，错误在查询参数适配。修复属于产品代码，并需增加真实连接边界回归。

R2 更新截止时间是运行生命周期设计问题：把同一逻辑运行的恢复/修订预算，套到了用户未来主动发起的新资料研究上。隔天的新更新继续继承昨天的 deadline，无法调用模型。应定义独立更新运行的预算账本，并保留同次更新恢复时不重置和历史消耗不可抹除；不能简单清零原任务预算。

R3 失败更新去重是状态语义问题：把“已入队”当作“资料已经检查完”。首次模型请求失败后资料尚未读取，却被去重过滤。应持久区分待处理、已检查、失败可重试，继续保留成功处理的来源去重和幂等约束。

这三项并非修改测试即可解决。现有 mock 未覆盖真实解析格式，S20 旅程从已有报告开始，S17 fixture 直接提交更新报告而未跨原截止时间执行 Worker，也没有模拟“排队后、读取前”失败。因此还存在验收覆盖不足：原测试验证的局部属性成立，并不等于完整用户旅程可用。

S19 是另外一层业务质量问题：缺答计入全分母后数值 9/18、问题 3/6，不能用“已回答部分无硬门错误”替代完成度。真实案例记录中存在工具预算耗尽、原因证据不足和语义核验未完成；没有证据把这些全部归因于 Windows 或本次三个缺陷。用户原人工确认已经登记，不需要再次确认同一批报告；后续优化后的独立验收需使用新的未见样本。

### 是否需要用户协助

现阶段没有必须由用户提供的代码信息、凭据或额外人工确认。三个产品缺陷、测试路径/换行/品牌/归档权限和诊断计时都可继续通过工程工作处理。当前只读环境探测显示 Docker 已响应且 OSType=linux，WSL 仅列出 docker-desktop；可以优先准备隔离 Linux 测试环境，无需现在要求用户开启 Windows 管理员权限。

如果最终要求 Windows 原生也执行真实文件符号链接测试，而当前系统策略持续禁止创建链接，届时可能需要用户或管理员允许相应开发权限。Linux 容器后端可用尚不等于 namespace 安全测试已通过，须另外验证实际文件系统、运行权限和依赖。后续新一轮财务质量验收的人工原文判断需要真实审核者参与；已有批次确认继续有效。当前没有开展付费模型重跑、业务库操作或暂缓的依赖审计。

### 本轮证据边界

本轮四项原测试结果为 2 passed / 2 failed：两个历史超时用例通过，Skill 5026/5000 与篡改包前置权限错误仍失败。相关实现、测试、capsule 配置和资源与原隔离副本在 LF 规范化后相同；不把环境变化后的成功归因于源码修复。未重跑全部 35 项、完整发布门或 Linux 安全测试，也没有声称 CI 通过。

证据保存于 `data/research-agent-upgrade/evidence/failure-root-causes/20261020-01/`：`focused-tests.json`、`skill-length.json`、`skill-normalization-probe.json`、`platform-probes.json` 和 `manifest.json`。原 `s20-release-03.log` 的 SHA-256 已重新核对一致，历史失败与新诊断结果分开保存。

## 2026-10-20 修复进展（原 35 项结果保留）

路径夹具、迁移/组件 CRLF 比较、旧品牌断言和 tar 重打包权限已修复。生产沙箱策略和敏感路径断言保持原义；Linux 监听接管与非 Linux 安全回退分别验证。Windows 定向 28+1+1 项通过，未执行分支不计成功。

Skill 读取现在与 source lock 使用相同的 LF 语义；源码目录和已验证安装包的 LF/CRLF 等价回归通过。原 5000 字符用例由 5026 降至 4986（system 837 / task 4149），预算没有提高，原子 capsule 不截断。Skills registry/14 个脚本检查与 type-check 通过。

对完整测试限制为 2 个 worker 后，原 PI loop / 镜像安装用例分别约 2013 / 635 ms，通过原 5000 ms 上限。Vitest 默认并发固定为 2，限制冷导入和文件密集任务争用；历史超时没有完整剖析，不能宣称已证明唯一根因。当前 Windows 整套为 1420 passed / 44 failed / 76 skipped；44 项由 19 个 EPERM 和另外发现的 25 个短路径别名夹具失败组成。后者规范化夹具真实路径后，该文件 27 项通过；整套尚待 Linux 验证，不能将当前结果写成发布通过。

证据在忽略目录 `data/research-agent-upgrade/evidence/release-repair-01/repair-checks.json`。Linux `npm ci` 实测仍拒绝旧的 @emnapi 锁文件不一致；依赖审计/锁文件按用户既定要求暂缓，仓库依赖文件未改。隔离环境准备测试依赖只用于验证代码，不能替代可复现安装通过证明。

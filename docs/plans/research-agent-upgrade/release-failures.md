# S20 完整发布门：35 个失败用例清单

本表逐项对应 Windows 独立 checkout 的 `s20-release-03.log`：21 个测试文件、35 个用例失败，1418 passed / 71 skipped；发布门前 17 项通过。原日志 SHA-256 为 `c32ed342f47e627197157fcb7eaa4f9025204d33ebab4b5cc448619fd9c5e84b`，源码身份见 `S20/validation-snapshot-v3.json`。这是历史实跑结果，本次只核对日志、源码和字符串副本，没有重跑完整发布门。

本次清单与无模型字节核对保存于 `data/research-agent-upgrade/evidence/S20/failure-inventory-20261020-01/inventory.json`，SHA-256 `4a18962fd8df63e8432107e9b5b3da29699db79b3c6c8c988e4ce053de1392e0`。原失败日志及验证快照保持不变。

## 数量与含义

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

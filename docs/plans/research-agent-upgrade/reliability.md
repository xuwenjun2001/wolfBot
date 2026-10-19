# 研究任务的恢复、隔离和运行观测

S18 检查的是运行可靠性，不是财报答案准确率。运行结果、失败及交接见 [progress.md](progress.md#验收证据)；报告质量另由 S19 评测。

## 如何定位一次研究

财报 Worker 的 stdout 现在输出单行 JSON，`service=company-research`。每条记录关联 taskId、attemptId、requestRevision、planRevision、reportRevision 和 generation；model、工具和交付使用相同身份。`report.committed` 使用新报告 revision，之前的阶段指向启动时已存在的报告。事件包括 attempt.started/finished/fenced/deadline、model.started/finished、tool.started/finished 和 report.committed。解析、检索、核验与交付通过 stage 区分。

沿用当前 Worker stdout/runtime 文件与 Alloy/Loki 收集路径，不增加 OTel 或另一套监控平台。先按 taskId 查询，再比较 generation 和 attemptId；发现旧 generation 的日志不等于旧写入获准，最终以数据库不可变报告和公开事件为准。运行 Worker 的方式与日志入口见[公司研究](../../company-research.md)和[运行手册](../../operations-runbook.md)。

生产观测只记录允许的元数据，不记录 actor、模型对话、工具参数、原文、错误正文或隐藏推理。可选 financial trace 仍是受控本地调试材料，可能含公开来源片段，不能直接接入公共日志。日志 sink 失败不授予执行权，也不能改变研究提交结果。

## 故障矩阵

| 场景 | 本轮结果与证据类型 | 判定边界 |
| --- | --- | --- |
| Worker 强制中断与接管 | 真正 fork Node 子进程执行 PI，第二个模型请求进入等待后 SIGKILL；正常等待租约过期，新进程接管 | 实际操作系统进程和 PostgreSQL；模型使用明确协议替身，不算真实模型质量 |
| 旧 attempt 晚写 | 接管后旧 heartbeat/checkpoint 被 LEASE_LOST 拒绝；原先预算耗尽/取消/导入和解析晚回调回归通过 | SQL 并发与真实库；不宣称外部只读请求 exactly-once |
| 预算继承 | 中断前工具 1，恢复后 3；原 startedAt/deadline 完全相同；终态再次执行不增加报告版本 | 已知输入/输出 Token 小计 300/30，另有 1 次未知模型请求；未知不被抹掉 |
| 模型超时 | 请求开始后注入 transport TimeoutError，报告 partial、无编造事实，unknown requests=1 | 协议故障注入，不是实际网关超时压测 |
| 解析失败 | 损坏 PDF 走真实 native parser 后抛错，原件/version/state 保留，不标解析成功 | 合成损坏原件；OCR 服务超时/取消另见 Python 测试和既有 S08 容器实测 |
| 取消期间回调 | 已有模型响应取消、导入/解析晚返回和旧 generation 写入回归通过 | 数据库竞争测试，不靠仅检查 AbortSignal |
| SSE 丢失/重连/切换 | 状态测试复验；S14 真实 EventSource 故障回放证据保留 | 当前状态逻辑实跑与历史浏览器回放分开；恢复从权威 snapshot 开始 |
| 跨用户访问 | task/原件/检索/报告 API 与 PG 归属负例通过，工具额外 actor/task 字段拒绝 | 服务端可信 actor；不能通过文档正文改授权 |
| SSRF/恶意文档 | 内网/非法类型/大小边界、HTML script 剥离、阅读器文本渲染和无凭据外链检查通过 | 固定负例，不代表全互联网攻击覆盖 |
| 来源提示注入 | 固定文档/恶意字段按非可信数据处理；工具 schema 拒绝权限夹带，无 shell/SQL/任意 URL 工具 | 防护合同测试；没有声称经过大规模真实模型红队测量 |

本轮真实中断产物在 `data/research-agent-upgrade/evidence/S18/276ea846-dabb-485a-8602-00fd4319f6d7/interruption.json`，SHA-256 `6173c8585ea724609e3f3e23533040083386acdbdceda22958a91b69b997eb8c`。自然租约等待 63514 ms，整个实验 67280 ms。旧进程退出回执为 SIGKILL，generation 从 1 到 2，恢复只提交一个 partial 报告。实验没有修改租约时钟或重置预算。

全新原生 PG 演练 manifest 在 `S05/rehearsal-276ea846-dabb-485a-8602-00fd4319f6d7/manifest.json`，44/44 数据库测试、兼容迁移和实际中断通过，nativeClusterStopped=true。C 盘满导致 npm 临时文件失败、Docker 调用无响应；未清理无关数据，使用 D 盘临时/cache 与仓库已有 PostgreSQL 16.14 二进制启动全新测试集群。两次测试断言修正前的失败批次保留；早先 1.5 秒 deadline 用例未进入模型，不能当作模型超时通过。

## 复现与恢复

默认 Docker 环境：

```powershell
npm run test:research:postgres -- --reliability
```

需要原生备用时显式指定可信 PostgreSQL bin 目录：

```powershell
node scripts/checks/run-research-postgres-integration.js --native-postgres=<postgres-bin> --reliability
```

runner 每次创建自己的 `research_test`，先旧库再追加迁移，使用独立生成 Client，不替换开发服务已加载的 DLL。原生集群保留磁盘证据、最终停止；Docker 容器最终移除。中断脚本只允许 runner 注入的 localhost 测试库。不要把 DATABASE_URL 指向应用库来手工复现。

运行中的 Worker 丢失后，保持原 task 不变，正常启动 `npm run worker:research`；等待原 60 秒 lease 过期后由现有 claim 接管，heartbeat 间隔 10 秒。不要通过删除 attempt、改 deadline 或重置 tool_calls“恢复”。取消/修订已经使 generation 失效时，旧进程必须放弃提交；模型会从已保存公开状态重新规划，不恢复旧隐藏会话。

## 资源与费用口径

attempt.finished 给出该进程运行期间的 CPU 增量、结束时 RSS 和耗时，**RSS 不是峰值**；多任务并行时不能把进程资源样本当成任务独占资源。工具和模型分别记录耗时，模型请求在开始前预留未知用量，得到有效 usage 再结算。已知 Token 小计与 unknownModelRequests 同时解释，存在未知请求时不能把小计当总成本。

报告正文/工具输出、checkpoint 160 KB、检索字符/页数、工具 40 次、默认 20 分钟均沿用现有边界；OCR 独立 CPU 服务的 2 CPU/4 GiB/单槽及历史实测见 [parser README](../../../services/document-parser/README.md)。本轮没有重新进行 CPU 容器压力测试，也未改变金融任务预算。没有可信价格回执时日志 `cost=unknown`，不写成免费或零费用。

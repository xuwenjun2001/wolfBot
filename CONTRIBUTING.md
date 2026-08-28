# Contributing to WolfBot

感谢贡献。仓库目前处于治理骨架阶段；首个业务实现进入后，应把实际技术栈和命令补充到 README 与项目全景图。

## 开发流程

1. 从最新 `main` 创建主题分支，避免在 `main` 上积累未评审改动。
2. 阅读 [AGENTS.md](AGENTS.md) 和 [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)，确定代码入口、影响范围和验证方式。
3. 先实现最小可用改动，再补充边界处理、错误路径和必要测试。
4. 执行受影响的测试和静态检查，并运行 `git diff --check`。
5. 结构变化同步更新项目全景图；`feat` 或 `fix` 同步更新 `CHANGELOG.md`。
6. 按提交规范创建小而完整的提交，提交前复核暂存区内容。
7. 发起评审时说明背景、行为变化、验证结果、兼容性和已知风险。

## 提交规范

提交标题采用：

```text
<type>(<scope>): <简短、明确的摘要>
```

允许的 `type`：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`build`、`ci`、`perf`、`revert`。

提交正文必须包含：

```text
Why: 触发原因、用户影响或维护背景
How: 关键修改和取舍
Validation: 命令、测试或手工检查及结果
```

`feat` 和 `fix` 还必须生成 `WB-YYYYMMDD-NNN`，在 `CHANGELOG.md` 增加一行，并在提交正文末尾加入：

```text
Change-Id: WB-YYYYMMDD-NNN
```

变更表只登记 `feat` 和 `fix`；`docs`、`chore` 等提交的 Why/How/Validation 保证它们仍可从 Git 历史追溯。

## 文档与全景图

任何新增模块、入口、外部依赖、配置、数据流或测试命令，都必须在同一提交更新 [项目全景图](docs/PROJECT_MAP.md)。只要用户行为或使用方式发生变化，也要更新 README。

## 评审检查

- 是否只修改了任务需要的文件？
- 是否覆盖主流程、边界和失败路径？
- 是否有回归测试或清楚记录了无法自动化的原因？
- 是否暴露密钥、个人数据、原始数据或生成物？
- 是否同步了文档、全景图和 `feat`/`fix` 变更表？
- 提交正文是否包含 Why、How、Validation，且验证结果可复核？

没有运行测试时必须明确写出原因；不要把“代码看起来正确”当作验证结果。

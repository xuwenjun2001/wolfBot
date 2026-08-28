# WolfBot

WolfBot 是一个从干净仓库起步的项目。当前版本只包含工程治理文档，业务代码和运行时入口尚未加入。

## 文档入口

- [AGENTS.md](AGENTS.md)：代理和维护者必须遵守的仓库级工作规范。
- [CONTRIBUTING.md](CONTRIBUTING.md)：分支、验证、提交和评审流程。
- [项目全景图](docs/PROJECT_MAP.md)：当前文件定位、未来模块登记和文档同步规则。
- [CHANGELOG.md](CHANGELOG.md)：`feat` 和 `fix` 的可追溯记录。
- [.gitmessage](.gitmessage)：提交正文模板。

## 当前状态

- 仓库默认分支：`main`
- 当前没有可运行的应用、服务或命令行入口。
- 技术栈确定并加入首个功能后，必须同步补充启动命令、测试命令和项目全景图。

## 开始贡献

1. 阅读 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。
2. 查看 [项目全景图](docs/PROJECT_MAP.md)，先确认修改位置和影响范围。
3. 完成功能、修复或文档变更，并按仓库规范验证。
4. 需要时更新项目全景图；`feat` 或 `fix` 还必须更新 [CHANGELOG.md](CHANGELOG.md)。
5. 使用 Conventional Commits 提交，并在正文填写 `Why`、`How`、`Validation`。

## 设计原则

- 让代码、测试、文档和提交记录互相可定位。
- 优先小而明确的改动，避免无关重构和隐式行为。
- 不把密钥、个人数据或未经许可的原始数据提交到仓库。
- 没有可靠验证时如实说明，不以未执行的测试代替验证结论。

# 本地文档解析服务

这个可选服务把 PDF 转成有页、块、表格单元格和真实坐标的 v2 回执。Docling 负责版面与表格，RapidOCR + ONNX Runtime 负责中文扫描页。金额规范化、披露时间、用户权限和金融判断由 TypeScript 研究层处理，解析器只接受 PDF bytes。

它使用独立 Python 3.12 环境，避免改变 market-data 的依赖。`uv.lock` 锁定 Docling、RapidOCR、ONNX Runtime 与 CPU 版 Torch/torchvision；本轮实跑版本和限制见[研究进度](../../docs/plans/research-agent-upgrade/progress.md)。模型文件及解析缓存都在忽略的 `data/document-parser/`，不进入 Git。

## Windows 本地启动

在项目根目录运行，先安装依赖并下载模型。这一步需要网络；日常解析不访问远程模型服务。

```powershell
uv sync --project services/document-parser --frozen
$env:DOCUMENT_PARSER_MODELS = Join-Path (Get-Location) 'data/document-parser/models'
uv run --no-sync --project services/document-parser python services/document-parser/bootstrap.py
$env:DOCUMENT_PARSER_CACHE = Join-Path (Get-Location) 'data/document-parser/cache'
$env:DOCUMENT_PARSER_TOKEN = 'local-development-parser'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
uv run --no-sync --project services/document-parser python -m uvicorn app:app --app-dir services/document-parser --host 127.0.0.1 --port 7821 --workers 1
```

启动后，带 `Authorization: Bearer <token>` 访问 `/health`，应返回解析器指纹、`device=cpu`、`concurrency=1`。指纹包含包版本和模型内容摘要；重新下载的权重变化会使缓存失效。Windows 运行中的模型进程会持有 DLL，先停止本服务再同步依赖，避免与 `uv sync` 同时修改其虚拟环境。

## Docker 开发配置

先按上述步骤把模型下载到根目录的 `data/document-parser/models`，再运行：

```bash
docker compose -f docker-compose.parser.yml build
docker compose -f docker-compose.parser.yml up -d
docker compose -f docker-compose.parser.yml ps
```

编排只发布 `127.0.0.1:7821`，模型只读挂载、缓存单独挂载；容器使用非 root、只读根文件系统、2 CPU、4 GB 内存和单个模型 Worker。`uv sync --frozen --no-dev --no-cache` 不把下载缓存留进镜像。以上是配置上限，实际峰值内存和镜像体积要以目标机器验收为准。开发默认 token 仅用于回环地址联调，其他部署由运行方配置独立凭据。

2026-10-19 本机原生 CPU 服务实跑通过，Docker 构建停在镜像解包，随后引擎返回 500、containerd 日志出现 SIGBUS。当天排障后引擎已恢复，客户端/服务端均为 API 1.55，但 C 盘仍只剩约 2 GB；现存 dev 镜像 history 还是没有 `--no-cache` 的旧配方，不能据此验收当前版本。先解决主机存储余量，再执行本节构建、健康和资源实测；原生验证不替代容器验证。失败与恢复记录见[进度 E-S08-01/03](../../docs/plans/research-agent-upgrade/progress.md)。不要用全局 prune 或反复重启共享 Docker 代替定位。

## 协议和限制

所有接口都要求服务端 token，不接收用户 URL、文件路径或模型指令。

| 接口 | 行为 |
| --- | --- |
| `POST /jobs` | `Content-Type: application/pdf`；原件最多 50 MB；返回 `jobId`，已有工作时 429 |
| `GET /jobs/{id}` | queued/running/completed/failed、已完成页数及终态回执 |
| `DELETE /jobs/{id}` | 停止自己的模型进程，已完成页保留，下一任务重新启动进程 |
| `GET /health` | 包/权重指纹和 CPU/并发配置，不证明任意文件能解析 |

查询参数为 `maxPages=500`（1—1000）、`maxCharacters=2000000`（100—5000000）、`forceOcr=false`、`timeoutSeconds=180`（1—1200）。原件总页数最多 10000，单页正文最多 50 万字符，栅格化有像素预算。平台 parse API 的总请求期限为 240 秒；调高本服务超时不会扩大研究任务总预算，也不会越过调用方期限。

进程按页交付；取消、超时、失败与字符截断进入显式 warnings/failedPages/truncatedPages。接口最近保留 16 个任务响应，重启后不恢复任务队列。模型进程可以重启并复用已完成的版本化页缓存；错误页不写成成功缓存。平台不会复用超时、取消、Worker 中断和 OCR 失败回退的最终回执，下一次可以重试。

OCR 和自动重建的表格都标记 `needs_review`。低质量块不能直接成为已核实财务事实；样本人工验收也不会自动解除某份业务资料的质量标记。页坐标归一化到 0—1，只有引擎实际给出的框才输出；跨页表保留各自页/表 ID，不自动合并。原生正文放在 `nativeText`，原始 Docling 结果另存缓存供诊断。

缓存是持有 PDF bytes 后才能触发的私有服务缓存，不提供按摘要读取资料的公网接口。缓存可能含原文及表格；它与平台的 actor 隔离原件目录分别管理，没有默认 TTL 或自动 GC。停服务后由运行方按资料保留范围清理，长期验收证据先归档，不把缓存当作唯一备份。

## 验证

```bash
uv lock --check --project services/document-parser
uv run --no-sync --project services/document-parser ruff check services/document-parser
uv run --no-sync --project services/document-parser pytest services/document-parser/tests -q
uv run --no-sync --project services/document-parser pip-audit --format json --output data/research-agent-upgrade/evidence/S08/audit.json
node --import tsx scripts/research/verify-ocr.ts
node --import tsx scripts/research/verify-parser-service.ts
```

最后两个脚本分别核对公开开发样本的行/年份/金额，以及运行中的 HTTP 服务。服务验证需要上述 token 环境变量及本地合成压力样本；实际输入、准备办法、失败和人工抽查状态统一登记在[进度](../../docs/plans/research-agent-upgrade/progress.md)。`probe.py` 只读取冻结开发资料；`make_probe_samples.py` 用明确标签生成合成扫描表，不代表真实公司数据。单测使用替身验证协议和停止行为，不能代替真实 OCR 或人工核对。

本轮 pip-audit 检查了 130 个可查询包，未发现已知漏洞；`torch/torchvision` 的 `+cpu` 版本被 PyPI 数据源跳过，另外按相应上游版本查过漏洞记录，结果也为零。上游记录不证明 CPU 二进制的完整审计。合成样本第二页的“合并口径”实际识别为“合井口径”，已保留该错误，不能由金额命中推导整表完全正确。

2026-10-19 用户对本批原图与表格的单位、年份列、括号负数、负号、小数/零和合并表头逐项核对并确认通过，登记为 E-S08-02。原抽查材料保留确认前快照，最新确认在 `data/research-agent-upgrade/evidence/S08/human-review-01/acceptance.json`。这是样本人工抽查通过，业务资料仍保留 needs_review，Docker 镜像/容器/资源验收仍待补。

平台的 `native/auto/docling/ocr` 路由、检索及后续 Agent 接线见[公司研究](../../docs/company-research.md)。

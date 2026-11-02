# 受控原生 Ombre 服务（阶段 3E）

本目录是对固定 Ombre Brain 3.6.14 的薄扩展。正文只有原生普通 `dynamic` Markdown 桶；使用其创建、精确读取、桶锁、原子发布、路径索引、原生 SQLite embedding 和 hash-only outbox。未修改下载的上游源码。新增 SQLite journal 只保存操作身份与证明，不保存正文，也不建立第二套 Memory 生命周期。

当前公开 `shiyu_memory_create`、`shiyu_memory_get`、`shiyu_memory_operation_status` 三个私有 stdio 工具，完整结构见 [PROTOCOL.md](PROTOCOL.md)。服务不代替识雨控制域授权：调用方必须先验证可信 owner、来源版本、命令、预算和取消状态。backend/scope/deployment 只是持久绑定。没有通用上游工具、更新、删除、CAS、自主演化或公共 HTTP 服务；普通记忆擦除尚待正式实现，不能拿 test_data 权限绕过。

## 安装与启动

源码、环境与临时数据均在 `plugins/shiyu/.local/ombre/`，由现有 `.gitignore` 排除。`SOURCE.json` 固定 commit、archive、源码树、lock 和 MIT 许可 hash。`requirements.lock.txt` 原样保留上游哈希锁；当前实际安装 CPython 3.12.16、mcp 1.29.0。安装不启动服务或模型：

```sh
<existing-python-3.12.16> -I service/ombre/prepare.py --python <absolute-python-3.12.16> --uv <absolute-existing-uv>
```

固定机器上的现有解释器来源是 DFY/embed-eval 的 CPython 3.12.16 和 uv；没有全局安装或改动该环境。`prepare.py --verify-only` 仅核对已解压上游源码，不下载/同步依赖。已有下载源码不匹配立即失败，不覆盖。

受信 launcher 用干净环境在 Python 启动前隔离凭据/PYTHONPATH：

```sh
/usr/bin/env -i PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1 \
  <product>/.local/ombre/.venv/bin/python -I -B -u <product>/service/ombre/service.py \
  --upstream <product>/.local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935 \
  --root <dedicated-vault> --backend-id ombre-local --scope local-owner \
  --deployment-id <stable-trusted-id> --without-embedding
```

路径来自受信安装配置，不能由模型正文或 MCP 参数指定。首次根必须为空；已有 journal 必须含精确匹配的 installation metadata。同根同时只有一个服务实例；不要同时运行上游完整服务管理该根。stdio EOF 正常关闭释放 journal/进程锁。启动只恢复 unknown 的现有证据，不重新发送 create；status/get 无写操作。

FastMCP 1.29.0 默认读取 cwd `.env`，因此专用服务构造期间使用同 SDK Settings 的窄子类，关闭 env_file/secrets_dir，只采用显式构造来源，构造后恢复模块类。没有读入用户 `.env`。Python `-I` 与父进程 `env -i` 在脚本导入前生效。

## 本地 embedding

启用时用 `--embedding-endpoint http://127.0.0.1:<port>/v1/embeddings` 替代 `--without-embedding`。仅支持 [harrier_profile.py](harrier_profile.py) 的固定 Harrier profile；launcher 仍需独立核对 llama-server 和 GGUF 权重 hash，HTTP model 名称无法证明权重。服务自身不下载/启动模型。关闭 embedding 不阻止正文创建。

原生 create 可同步尝试一次派生索引；未启动 outbox worker、自动重试或任何自主后台。native `_index_after_update` 会吞索引错误保留正文，因此 receipt 的 `indexState` 保守为 `unknown`；未装 embedding 为 `disabled`。调用方不能把 bodyDurable 当作 indexed。Harrier 子类保持原生 SQLite/检索结构，加固定 query/document 前缀、profile 指纹、单次 loopback HTTP 和错误码；启用时是 embedding 模型调用，不得称零模型。

## 本轮验证范围

用真实固定依赖、临时合成普通桶跑 Python 模块测试；MCP 通过真实 stdio 子进程执行 create、正常关闭、重新启动 get，结构化输出与 JSON 文本相等。另由测试持有的子进程在 intent 后/原生发布后分别 SIGKILL：前者重开仍 unknown 且无桶，后者重开核对原文件后补回执，文件 hash 不变。测试不证明硬件掉电和恶意本机篡改安全。临时 vault 自动清理，未读写实际业务 vault/DSH。

```sh
PYTHONDONTWRITEBYTECODE=1 .local/ombre/.venv/bin/python -m unittest discover -s service/ombre/tests -v
```

最终数量/源码快照在 [validation.json](validation.json)。没有生成模型、账号、付费调用或真实资料。Harrier 单元测试的 HTTP 响应为受控本地替身，不冒充真实模型验收。

## 许可与边界

上游 MIT 许可保留 [LICENSE](LICENSE)，原 archive 为 1087 bytes / CRLF，SHA256 `2c1ba2fc863528b42e0d904205792f538ecf01c7555c0a7ed2080897362b41b6`。既有 research 快照为 1066 bytes / LF；CRLF→LF 后一致，字节 hash 差异不是来源污染。上游声明和本次实测分别记录；此受控切片不声称完整 Ombre 自主能力已接入。

# DSCord 存储来源与核查记录

检索日期为 2026-11-04（America/Caracas）。UTC 时间跨至 2026-11-05，逐文件时间与 SHA-256 见 [sources.json](<sources.json>)。

本目录保存决定选型的最少上游证据，上游文本作为研究材料读取。资料阶段完成后，主代理按本轮实施授权安排了隔离容器协议实验，执行范围与结果见 [实验结果](<../../测试/2026-11-04-DSCord存储/结果.md>)。

结论与接口草案见 [DSCord 多后端存储](<../../技术候选/DSCord多后端存储.md>)。本目录记录官方资料与固定源码证据，真实协议结果另行留证，真实云账号接入仍待验收。

## 固定版本

| 候选 | 版本 / 提交 | 官方发行时间（UTC） | 许可 |
|---|---|---|---|
| rclone | v1.75.2 / `be8d6044eacb843b74d335db0c5fbe09222031fe` | 2026-10-09 11:03:19 | MIT |
| Synapse S3 provider | v1.7.0 / `208157c67ec7321515d07915bb276ae30d69d760` | 2026-08-18 16:25:46 | Apache-2.0 |
| Synapse 接口核查 | v1.164.2 | 仅用于接口基线核查 | 文件头为 AGPL-3.0-or-later |
| OpenList | v4.2.9 / `0497ee853853eff5fc0ada9f21684a990887de83` | 2026-10-25 05:28:47 | AGPL-3.0 |
| AList | v3.66.0 | 2026-10-21 10:35:01 | AGPL-3.0 |
| matrix-media-repo | v1.3.8 | 2025-01-16 18:39:46 | MIT |

发行信息通过 GitHub 官方仓库的 `releases/latest` API 核对，保存于 [releases.json](<releases.json>)，固定提交通过对应 tag 解引用核对。OpenList 和 AList 官方仓库均未归档且有近期发行。维护时间用于本轮版本选择，功能是否适配仍依据接口与源码。

## 本地快照

| 文件 | 核查用途 | 上游来源 |
|---|---|---|
| [rclone-v1.75.2-serve-s3.md](<rclone-v1.75.2-serve-s3.md>) | Experimental 标记、认证、multipart、VFS 完成语义 | [固定版本](https://github.com/rclone/rclone/blob/v1.75.2/cmd/serve/s3/serve_s3.md) |
| [synapse-s3-v1.7.0-README.md](<synapse-s3-v1.7.0-README.md>) | endpoint、同步写配置、迁移脚本 PostgreSQL 依赖 | [固定版本](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/README.md) |
| [synapse-v1.164.2-storage-provider.txt](<synapse-v1.164.2-storage-provider.txt>) | `store_file/fetch` 接口、local/remote 开关与同步等待 | [固定版本](https://github.com/element-hq/synapse/blob/v1.164.2/synapse/media/storage_provider.py) |
| [openlist-v4.2.9-search-model.txt](<openlist-v4.2.9-search-model.txt>) | 搜索节点包含父路径、名称、目录标记和大小 | [固定版本](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/internal/model/search.go) |

上游许可文本随材料保存，分别为 [MIT](<LICENSE-rclone-MIT.txt>)、[Apache-2.0](<LICENSE-provider-Apache-2.0.txt>) 与 [AGPL-3.0](<LICENSE-OpenList-AGPL-3.0.txt>)。Synapse 快照保留其文件头中的 AGPL-3.0-or-later 声明和版权信息。

## 补充官方来源

- rclone 四后端与控制接口核查见 [Drive](https://rclone.org/drive/)、[OneDrive](https://rclone.org/onedrive/)、[S3/R2](https://rclone.org/s3/#cloudflare-r2)、[RC](https://rclone.org/rc/)。
- Synapse 实际上传与读取方法见 [provider v1.7.0](https://github.com/matrix-org/synapse-s3-storage-provider/blob/v1.7.0/s3_storage_provider.py)。接口核查确认需要另行处理远端删除。
- R2 兼容范围与一致性见 [S3 API](https://developers.cloudflare.com/r2/api/s3/api/)、[一致性说明](https://developers.cloudflare.com/r2/reference/consistency/)。本轮未连接 R2。
- OpenList 的后端入口见 [S3](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/s3/driver.go)、[Google Drive](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/google_drive/driver.go)、[OneDrive](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/drivers/onedrive/driver.go)。
- OpenList 的分页、路径权限与索引更新见 [fsread.go](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/server/handles/fsread.go)、[build.go](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/internal/search/build.go)、[搜索文档](https://doc.oplist.org/guide/advanced/search)。
- OpenList sidecar 接入形式见 [REST 路由](https://github.com/OpenListTeam/OpenList/blob/v4.2.9/server/router.go)、[WebDAV](https://doc.oplist.org/guide/advanced/webdav)、[S3 Gateway](https://doc.oplist.org/guide/advanced/s3)。
- matrix-media-repo 的范围见 [v1.3.8 README](https://github.com/t2bot/matrix-media-repo/blob/v1.3.8/README.md) 与 [配置样例](https://github.com/t2bot/matrix-media-repo/blob/v1.3.8/config.sample.yaml)。本轮未做其部署实验。

## 复核方式与限制

本轮通过公开 GitHub API 核实版本、许可与仓库状态，通过固定 tag 原始源码核查接口，通过官方文档核查 OAuth 和兼容范围。快照下载仅保留公开资料，SHA-256 已记录。滚动文档以后可能更新，涉及执行语义时以固定版本证据为准。

DSCord 初始路径核查覆盖 `src/media.mjs`、`scripts/server-init.mjs` 与 `scripts/matrix.mjs`。同日后续实现范围为 local/S3 配置、部署模板与流式 Range 兼容。原有真实任务、存储静态核查和本轮协议实验分别记录。

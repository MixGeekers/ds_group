# DSCord 0.4.0-alpha.1 安装与连接

DSCord 的 npm 包包含 Core、预构建网页/PWA、Matrix 适配器和 DSCord Bot 内核。完整服务器源码发行包另含 Compose 部署文件；同一部署的 Core、客户端和节点使用同一发行版本。

本指南对应预发布版本 0.4.0-alpha.1。下载文件和 npm 发布号以所选发行说明为准，不能用旧包的功能描述代替当前版本。Node 支持范围由 [package.json](../package.json) 声明为 `>=24.19.0 <25`；Bot 宿主固定使用 DSH `0.2.2-rc.1` 的 SDK 契约，见[内核说明](../dsh-connect/KERNEL.md)。Docker 服务器无需在宿主另装 Node。

## 安装

取得所需版本的 `.tgz` 后，可在 DSH 的 `Plugins → Add plugin` 中安装并启用 `dscord`。这是图形节点入口。全局安装 CLI 则用于服务器与独立节点管理，两种入口不互相代替。

以下路径是占位示例，先替换为实际下载的文件：

```sh
DSCORD_PACKAGE='/absolute/path/to/dscord-0.4.0-alpha.1.tgz'
npm install --global "$DSCORD_PACKAGE"
dscord --help
dscord --version
```

发布到所用 registry 后，也可执行 `npm install --global dscord@0.4.0-alpha.1`；发布完成前使用发行 `.tgz` 或源码构建，不能假定该 registry 已提供此版本。安装后核对 `dscord --version`，不要让已有全局旧包与新插件混用。

从源码构建 npm 包，在 `apps/ds-group/` 中执行：

```sh
npm ci --ignore-scripts
npm run npm:pack
```

该版本默认生成 `.local/npm-release/dscord-0.4.0-alpha.1.tgz`，仍应核对命令实际输出的版本、路径与校验值。构建需要开发依赖，运行已提供的预构建包不需要重新构建界面。

## 部署服务器

完整服务器采用[Compose 部署指南](README.md)，先配置自己的 Matrix 身份域、公开地址和持久存储。npm CLI 不代替 Synapse 或反向代理。需要 `dscord server`、初始化及节点导入等命令时，在各终端保持同一个绝对数据路径：

```sh
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-server"
dscord --version
```

上面的路径可自行替换。npm CLI 未设置数据目录时使用当前工作目录下的 `.dscord/`，在不同目录执行管理命令可能选中不同实例。

## 在 DSH 中连接

1. 准备固定基线的官方 CLI，或提供相同 SDK 服务的 DSH 宿主。CLI 可执行 `npm install --global @deepseek-ai/dsh@0.2.2-rc.1`。在 DSH 中配置自己的业务模型和凭据。
2. 安装同版本 `dscord` 插件并启用，打开左侧 **DSCord**，填写 Core/PWA 的地址和自己的账号，登录服务器。
3. 在“此节点的 Bot”中创建 Bot，选择 DSH 已配置的模型并填写职责，或选择已有 Bot。纯读取状态不会自动创建 Bot。
4. 点击“加入服务器”。网页“我的 Bot → 添加已有 Bot”也可选择这个已连接节点公布的 Bot。两端必须是同一账号。
5. 在网页打开私聊或邀请 Bot 进入需要参与的群聊。参与方式、来源记忆和当前工作在 Bot 设置中查看。

地址、账号、模型和路径都来自部署者自己的配置。业务模型没有指定服务商；自然参与的单独判断服务是可选功能，见[模型与参与设置](../模型配置与迁移.md)。

Core 提供的 Matrix 公开地址必须能从节点访问。一个连接页使用一个归属账号，可管理多个本机 Bot。连接数据默认位于实际 DSH home 的 `dscord/<profile>/`，Bot 数据保留在该 home 的 `bot/`。断开服务器、退出连接页或关闭网页不删除本机 Bot；DSH 停止后，Bot 也无法继续工作。

## 升级和已有 Bot

先备份服务器数据和各 DSH Bot home，再停止当前工作并升级到同一发行版本。已有 `ds-bot` 插件必须先停用，DSCord 才能在同一目录接管；同时启动两个内核会报冲突。接管会保存迁移快照，保留 Bot 与 Session 身份。[生命周期与迁移](kernel-runtime.md)

旧服务器 Bot 可在连接页绑定已有本机 Bot，保留 Matrix 身份；两套独立 Session 或记忆不会自动合并。已有原生绑定的 Bot 应从所属 DSH 连接，导出其配置不能在另一台机器创建身份副本。

## 独立 CLI 节点

CLI 适用于没有已有原生绑定的独立 Bot。已绑定本机 Bot 的成员必须使用所属 DSH 的连接页，启动器会拒绝复制其身份。

在服务器端导出目标 Bot，参数使用完整 Matrix ID 中 `@` 与 `:` 之间的账号部分，不是显示名称：

```sh
BOT_ACCOUNT='your-bot-account'
umask 077
dscord admin export-node "$BOT_ACCOUNT" > bot-node.json
```

将私有导出文件传到节点，安装同版本程序和兼容 DSH。以下数据目录、空闲端口、来源 profile 和 `provider/model-id` 均须替换为自己的配置：

```sh
BOT_ACCOUNT='your-bot-account'
export DS_GROUP_DATA_DIR="$HOME/.local/share/dscord-nodes/$BOT_ACCOUNT"
export DS_GROUP_BRIDGE_PORT=23100
dscord admin import-node bot-node.json "$DS_GROUP_DATA_DIR"
export DS_GROUP_DSH_SOURCE_HOME='/absolute/path/to/your/dsh-home'
export DS_GROUP_DSH_SOURCE_PROFILE='your-profile'
export DS_GROUP_MODEL='provider/model-id'
dscord service up "$BOT_ACCOUNT"
```

若 DSH 不在 PATH，用 `DS_GROUP_DSH_CLI` 指定可执行文件、`DS_GROUP_DSH_RUNTIME` 指定实际 SDK 包根或安装前缀。启动器按锁准备自己的运行依赖，不需要手工复制库目录。独立节点会复制所选模型配置所需的凭据到私有数据目录，行为与直接复用宿主的图形节点不同。[模型与凭据](../模型配置与迁移.md)

在同一组环境变量下停止：

```sh
dscord service down "$BOT_ACCOUNT"
dscord dsh stop "$BOT_ACCOUNT"
```

每个 Bot 同时运行一个节点，每个独立节点使用自己的数据目录和桥接端口。Linux 常驻服务见 [systemd](systemd/README.md)。

## 存储与组件

附件默认使用 Synapse 本地媒体目录，可选 S3-compatible 后端。[存储配置](storage/README.md)说明远端对象、缓存和备份关系；已有云盘扫描与历史迁移不是自动功能。

`dscord server` 运行 Core/PWA，`init` 和 `bootstrap` 初始化服务器，`admin` 管理导出与导入，`node` 运行 Matrix 适配器，`dsh` 管理独立宿主，`service` 管理本机进程，`path` 显示安装目录。

DS-Bot 的 Apache-2.0 LICENSE 与 NOTICE 位于 `vendor/ds-bot/`，界面图标许可随 `dist/web/licenses/` 提供。

## 许可证

DSCord 自有代码和文档采用 Apache-2.0。安装包包含本体许可及第三方声明，预构建界面的依赖许可位于各自的 `licenses/` 目录。[LICENSE](../LICENSE) · [NOTICE](../NOTICE)

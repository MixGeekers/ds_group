# Linux Bot 常驻服务

这些模板将每个 Bot 的 DSH 宿主和 Matrix 接入进程分别交给 systemd 管理。同一个 Bot 的两个进程共享该 Bot 的节点配置，重启后复用持久 Session。不同 Bot 分别导出配置，使用各自的实例名、目录和桥接端口。

`/opt/ds-group`、`/usr/bin/node`、服务用户 `dsgroup` 与 `/etc/ds-group` 是随附单元的模板约定，可按部署选择成套修改。模板按 `/opt/ds-group` 放置发行包、`/usr/bin/node` 运行 Node.js 24.19.0。安装前运行 `command -v node` 和 `node --version`。若 Node 安装在其他位置，修改两个单元的 `ExecStart`，并在环境文件的 `PATH` 中加入该目录，供官方 DSH 的 Node shebang 与 `npm` 使用。

## 安装程序与节点数据

在 Linux 服务器安装 Node.js 24.19.0 与 npm。将发行包解压后的 `ds-group/` 内容放到 `/opt/ds-group`，然后执行以下命令。官方 DSH 安装在独立前缀中，当前适配版本为 `0.2.2-rc.1`。下方 `your-bot-account` 替换为 Bot 完整 ID 中 `@` 与 `:` 之间的账号部分，并在同一终端继续操作。服务用户已经存在时复用该用户。

```sh
BOT_ACCOUNT='your-bot-account'
sudo useradd --system --user-group --home-dir /var/lib/ds-group --create-home --shell /usr/sbin/nologin dsgroup
sudo install -d -m 0755 /opt/ds-group-runtime
sudo npm ci --prefix /opt/ds-group --omit=dev --ignore-scripts --no-audit --no-fund
sudo npm install --prefix /opt/ds-group-runtime --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1
sudo install -d -m 0700 -o dsgroup -g dsgroup "/var/lib/ds-group-$BOT_ACCOUNT"
sudo install -d -m 0700 /etc/ds-group
```

将核心服务器 `export-node` 导出的对应 Bot 配置传到当前服务器。下例 `/absolute/path/bot-node.json` 替换为实际私有文件路径。

```sh
sudo /usr/bin/node /opt/ds-group/scripts/server-admin.mjs import-node /absolute/path/bot-node.json "/var/lib/ds-group-$BOT_ACCOUNT"
sudo chown -R dsgroup:dsgroup "/var/lib/ds-group-$BOT_ACCOUNT"
sudo install -m 0600 /dev/null "/etc/ds-group/$BOT_ACCOUNT.env"
sudoedit "/etc/ds-group/$BOT_ACCOUNT.env"
```

填写以下环境配置。先在服务用户可读取的 DSH profile 中配置模型和凭据，再填写该来源和所选模型引用，详见[部署参数](../README.md#configuration)。导入配置已记录核心与 Matrix 的远端地址，需要覆盖 Core 地址时设置 `DS_GROUP_CORE_URL`。自定义 Bot 必须设置空闲的 `DS_GROUP_BRIDGE_PORT`；`23100` 只是示例。

```ini
PATH=/usr/local/bin:/usr/bin:/bin
DS_GROUP_DSH_RUNTIME=/opt/ds-group-runtime
DS_GROUP_BRIDGE_PORT=23100
DS_GROUP_DSH_SOURCE_HOME=/absolute/path/to/your/dsh-home
DS_GROUP_DSH_SOURCE_PROFILE=your-profile
DS_GROUP_MODEL=provider/model-id
```

增加另一个 Bot 时，将 `BOT_ACCOUNT` 改为它的账号部分，分别导入节点配置并建立环境文件，选择另一个空闲端口。`StateDirectory` 按实例保留各自数据，程序目录可以共用。来源路径、profile 和模型引用按服务用户的实际 DSH 安装填写，确认该用户可读取所选模型的配置与凭据。

## 启用与检查

```sh
sudo install -m 0644 /opt/ds-group/deploy/systemd/ds-group-dsh@.service /etc/systemd/system/
sudo install -m 0644 /opt/ds-group/deploy/systemd/ds-group-bot@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now "ds-group-dsh@$BOT_ACCOUNT.service" "ds-group-bot@$BOT_ACCOUNT.service"
sudo systemctl status "ds-group-dsh@$BOT_ACCOUNT.service" "ds-group-bot@$BOT_ACCOUNT.service"
sudo journalctl -u "ds-group-dsh@$BOT_ACCOUNT.service" -u "ds-group-bot@$BOT_ACCOUNT.service" -f
```

首次启动会安装固定 DS-Bot 运行依赖。接入进程在 DSH 就绪前可能退出，systemd 每 5 秒重试。DSH 单独重启时，接入进程保持运行并恢复与桥接端口通信。

```sh
sudo systemctl restart "ds-group-dsh@$BOT_ACCOUNT.service"
sudo systemctl restart "ds-group-bot@$BOT_ACCOUNT.service"
sudo systemctl stop "ds-group-bot@$BOT_ACCOUNT.service" "ds-group-dsh@$BOT_ACCOUNT.service"
```

程序升级前先停止同机所有 Bot 的这两个服务，保留 `/var/lib/ds-group-*` 与 `/etc/ds-group/`，更新 `/opt/ds-group` 的发行文件并执行 `npm ci`，然后启动对应实例。对 DSH 升级应先运行发行包的 `scripts/runtime-smoke.mjs` 验证 Session 生命周期，再切换固定运行版本。

## 验证范围

已有[发行验证](../../发行验证.md)记录了 Linux ARM64 原生容器、Linux x64 模拟容器和 macOS ARM64 的真实 DSH 插件加载、Session 创建、重启恢复与有序停止，模型调用为 0。systemd 单元的静态检查与目标 Linux 主机上的开机、日志、重启验收分别记录；本说明中的参数替换不代表已完成用户机器的运行验收。

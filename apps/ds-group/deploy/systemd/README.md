# Linux Bot 常驻服务

这些模板将每个 Bot 的 DSH 宿主和 Matrix 接入进程分别交给 systemd 管理。示例使用 `finance`，人事节点将实例名替换为 `hr`。它们共享核心服务器导出的同一个节点配置，并在重启后复用本机持久 Session。

模板按 `/opt/ds-group` 放置发行包、`/usr/bin/node` 运行 Node.js 24.19.0。安装前运行 `command -v node` 和 `node --version`。若 Node 安装在其他位置，修改两个单元的 `ExecStart`，并在环境文件的 `PATH` 中加入该目录，供官方 DSH 的 Node shebang 与 `npm` 使用。

## 安装程序与节点数据

在 Linux 服务器安装 Node.js 24.19.0 与 npm。将发行包解压后的 `ds-group/` 内容放到 `/opt/ds-group`，然后执行以下命令。官方 DSH 安装在独立前缀中，固定版本为 `0.2.1-rc.5`。

```sh
sudo useradd --system --user-group --home-dir /var/lib/ds-group --create-home --shell /usr/sbin/nologin dsgroup
sudo install -d -m 0755 /opt/ds-group-runtime
sudo npm ci --prefix /opt/ds-group --omit=dev --ignore-scripts --no-audit --no-fund
sudo npm install --prefix /opt/ds-group-runtime --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.5
sudo install -d -m 0700 -o dsgroup -g dsgroup /var/lib/ds-group-finance
sudo install -d -m 0700 /etc/ds-group
```

将核心服务器 `export-node finance` 生成的配置传到当前服务器。下例中的 `/tmp/finance-node.json` 替换为实际传输路径。

```sh
sudo /usr/bin/node /opt/ds-group/scripts/server-admin.mjs import-node /tmp/finance-node.json /var/lib/ds-group-finance
sudo chown -R dsgroup:dsgroup /var/lib/ds-group-finance
sudo install -m 0600 /dev/null /etc/ds-group/finance.env
sudoedit /etc/ds-group/finance.env
```

填写以下环境配置。`OPENCODE_API_KEY` 使用自己的 opencode 凭据，节点固定调用 `opencode-go/deepseek-v4.1-flash`。导入配置已记录核心与 Matrix 的远端地址，改变核心地址时可以设置 `DS_GROUP_CORE_URL`。`DS_GROUP_FINANCE_PORT` 与 `DS_GROUP_HR_PORT` 分别配置同机 Bot 的桥接端口。

```ini
PATH=/usr/local/bin:/usr/bin:/bin
DS_GROUP_DSH_RUNTIME=/opt/ds-group-runtime
DS_GROUP_FINANCE_PORT=18091
OPENCODE_API_KEY=replace-with-your-opencode-key
```

对于 `hr`，使用 `/var/lib/ds-group-hr`、`/etc/ds-group/hr.env` 和 `DS_GROUP_HR_PORT=18092`。`StateDirectory` 按实例保留各自数据，源码目录可共用。已有 opencode 配置也可通过 `DS_GROUP_DSH_SOURCE_HOME` 和 `DS_GROUP_DSH_SOURCE_PROFILE` 导入，此时省略 `OPENCODE_API_KEY`，并让服务用户能够读取该来源。

## 启用与检查

```sh
sudo install -m 0644 /opt/ds-group/deploy/systemd/ds-group-dsh@.service /etc/systemd/system/
sudo install -m 0644 /opt/ds-group/deploy/systemd/ds-group-bot@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ds-group-dsh@finance.service ds-group-bot@finance.service
sudo systemctl status ds-group-dsh@finance.service ds-group-bot@finance.service
sudo journalctl -u ds-group-dsh@finance.service -u ds-group-bot@finance.service -f
```

首次启动会安装固定 DS-Bot 运行依赖。接入进程在 DSH 就绪前可能退出，systemd 每 5 秒重试。DSH 单独重启时，接入进程保持运行并恢复与桥接端口通信。

```sh
sudo systemctl restart ds-group-dsh@finance.service
sudo systemctl restart ds-group-bot@finance.service
sudo systemctl stop ds-group-bot@finance.service ds-group-dsh@finance.service
```

程序升级前先停止同机所有 Bot 的这两个服务，保留 `/var/lib/ds-group-*` 与 `/etc/ds-group/`，更新 `/opt/ds-group` 的发行文件并执行 `npm ci`，然后启动对应实例。对 DSH 升级应先运行发行包的 `scripts/runtime-smoke.mjs` 验证 Session 生命周期，再切换固定运行版本。

## 验证范围

本轮实测了 Linux ARM64 原生容器、Linux x64 模拟容器和 macOS ARM64 的真实 DSH 插件加载、Session 创建、重启恢复与有序停止，模型调用为 0。systemd 单元通过静态检查，实际服务器上的开机启动、日志与重启行为需要在目标 Linux 主机验收。

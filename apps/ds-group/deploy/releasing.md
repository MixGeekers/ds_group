# 构建与发布 DSCord

本文面向维护者。应用源码根为 `apps/ds-group/`，实际发布由有仓库和 registry 权限的维护者执行。

## 版本与许可证

`package.json` 与 `package-lock.json` 使用同一版本；源码包、容器标签和 npm tarball 直接使用这个版本，打包脚本不会追加 `-alpha.1`。当前阶段为 `0.4.0-alpha.1`：GitHub Release 标记预发布，npm 使用 `alpha` 标签。通用稳定版本使用 `latest`，其他预发布使用其 `alpha` / `beta` / `rc` 渠道或 `next`。发布版本必须是规范 SemVer；统一容器标签不支持 `+build` 后缀。[npm 版本及标签说明](https://docs.npmjs.com/adding-dist-tags-to-packages/)

发布前先确定本体许可，在包根保存 `LICENSE`，并在 `package.json` 的 `license` 写入对应标识。缺少声明或许可文件时，公共发行构建会失败。第三方 DS-Bot 的 Apache-2.0 LICENSE/NOTICE、Ombre 的 MIT LICENSE 及前端依赖声明保持各自归属，不能用本体许可证替换。[npm 许可字段说明](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license)

## 发行内容

源码包包含应用与部署源码、正常测试及合成夹具、冻结依赖锁、公开使用指南、配置模板和必要许可证。它排除内部实施/验收记录、`deploy/evidence`、运行数据、机器配置、凭据、日志和缓存。规则在 `scripts/release-content.mjs`；新增对外配置或文档时同步更新清单。源码中的测试场景和合成模型设置是测试材料，不是对使用者模型或账号的要求。

npm 包包含预构建前端、服务器和 Bot 运行模块、必要用户/接口指南与许可证；不包含开发测试和实验报告。项目工作区的 `private: true` 保留，用于阻止直接把开发根目录误发到 registry；生成的独立 `dscord` tarball 才是发布对象。[npm private 字段](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#private)

## 本地构建与核对

```sh
npm ci --ignore-scripts
npm run check
npm run build
node scripts/release-pack.mjs
node scripts/release-verify.mjs --require-public-content --extract .local/release-unpacked
node scripts/npm-pack.mjs
```

源码包有逐文件清单和 SHA-256；公共内容策略验证会拒绝误加到清单中的内部报告。npm 产物位于 `.local/npm-release/dscord-版本.tgz`，可用 `tar -tzf` 检查实际内容。不要复用已经发布过的相同 npm 名称和版本；registry 不允许覆盖该组合。[npm publish 规则](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

## GitHub Release 与容器

`ds-group-v版本` 标签触发 `.github/workflows/ds-group-release.yml`，并要求与包版本和锁一致。工作流先执行完整 CI，再从经过清单验证的源码包构建 Linux amd64/arm64 镜像和独立 npm tarball。npm tarball 会做干净安装检查。最终 GitHub Release 提供源码、npm tarball、校验和和镜像 index；容器地址由 `scripts/release-metadata.mjs` 给出。

这个工作流发布 GitHub 资产与容器，不依赖 npm 登录或尚未配置的 OIDC。分支 CI 和本地 `pack` 不执行 registry 发布。

## 发布同一 tarball 到 npm

从对应 GitHub Release 下载 tarball 与 `SHA256SUMS`，校验后由 npm 维护者执行。这里以当前 Alpha 为例：

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish ./dscord-0.4.0-alpha.1.tgz --registry=https://registry.npmjs.org --access public --tag alpha --ignore-scripts
npm view dscord@0.4.0-alpha.1 version dist.integrity --registry=https://registry.npmjs.org
```

认证失败时先完成真实账号登录及需要的 2FA，不把 `npm publish` 的退出成功等同于公共 registry 已可安装；发布后回读版本/完整性并从 registry 做干净安装。未来采用 npm Trusted Publishing 时，需维护者在包设置授权准确的仓库、工作流文件及所需动作，再添加 GitHub OIDC 权限；它不是本工作流的默认依赖。[npm Trusted Publishing 官方步骤](https://docs.npmjs.com/trusted-publishers/)

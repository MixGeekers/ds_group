# DSCORD 品牌资产 v1

更新于 2026-11-04（America/Caracas）。用户在本次设计聊天中选定鲸鱼与普通气泡的组合，并要求整理为项目资产包。

鲸鱼代表 Agent，普通气泡代表人类。两个角色共同组成 DSCORD 的标志，蓝白配色沿用选定方案。

[打开本地预览](preview.html) · [查看选定方案](source/selected-concept.png) · [文件检查结果](validation.json)

## 文件与用途

| 路径 | 尺寸 | 用途 |
|---|---|---|
| `source/dscord-app-master.png` | 1254 × 1254 | 蓝底应用图标母版 |
| `source/dscord-mark-master.png` | 1254 × 1254 | 蓝色透明底标志母版 |
| `source/selected-concept.png` | 1536 × 1024 | 用户选定的图标与字标方向参考 |
| `source/generation-prompts.json` | JSON | 生图工具、提示词与本次导出方式 |
| `icons/icon-192.png` | 192 × 192 | PWA 图标，支持 `any maskable` |
| `icons/icon-512.png` | 512 × 512 | PWA 图标，支持 `any maskable` |
| `icons/icon-1024.png` | 1024 × 1024 | 大尺寸应用与项目图标，支持 `any maskable` |
| `icons/apple-touch-icon.png` | 180 × 180 | Apple Touch Icon |
| `icons/favicon-16.png`、`favicon-32.png`、`favicon-48.png` | 16、32、48 | 浏览器小图标 |
| `icons/favicon.ico` | 内含 16、32、48 三帧 | ICO 浏览器图标 |
| `marks/mark-{64,128,256,512,1024}.png` | 64 至 1024 | 文档、项目介绍及界面的透明底标志 |
| `manifest-icons.json` | JSON | 面向 `/icons/` 静态目录的 manifest 图标配置片段 |
| `SHA256SUMS` | SHA-256 | 包内文件完整性清单 |

## 接入现有 PWA

接入位置为 `apps/ds-group/web/icons/`、`web/index.html` 和 `web/manifest.webmanifest`。按以下步骤应用本包。

1. 将本包 `icons/` 中所需文件复制到 `web/icons/`。
2. 将 `manifest-icons.json` 的 `icons` 数组应用到现有 manifest 的同名字段，图标 URL 按部署路径调整。
3. 将 `web/index.html` 的图标引用更新为下列 PNG、ICO 和 Apple Touch Icon。项目当前入口使用 `icon.svg`，接入时需要同步更新该引用。
4. 在产品包根目录运行 `npm run build`，由现有 `scripts/build-pwa.mjs` 复制图标并更新离线缓存版本。
5. 分别验证桌面浏览器、Android 和 iOS 的安装图标与已有安装的图标更新。

```html
<link rel="icon" href="/icons/favicon.ico" sizes="16x16 32x32 48x48" />
<link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
```

`manifest-icons.json` 提供图标字段片段，应用的 `id`、启动路径、主题色与显示模式由产品 manifest 管理。多尺寸图标的声明方式依据 MDN 的 PWA 图标指南。[MDN 图标指南](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons)

## 使用约定

- 应用图标采用满铺蓝色背景，由操作系统施加圆形或圆角遮罩。
- 鲸鱼尾部与气泡尖角位于中央安全区。maskable 安全区按居中、半径为图标宽度 40% 的圆检查。[W3C 安全区定义](https://www.w3.org/TR/appmanifest/#icon-masks)
- 透明蓝色标志优先用于浅色表面。深色表面可使用蓝底应用图标。
- 各尺寸均从对应母版等比重采样。后续导出继续使用 `source/` 的母版。
- 当前母版格式为 PNG。独立可编辑字标与 SVG 矢量母版待制作。

## 来源与验证

图形由内置 ImageGen 根据用户提供的蓝色鲸鱼及圆润 Bot 角色参考生成。用户选定的设计板、最终两份母版及提示词随包保存。尺寸导出使用 macOS `sips`，ICO 封装同包的三份 PNG。

本轮实测覆盖 15 份 PNG 的解码与尺寸、应用图标的不透明通道、透明标志的 alpha 通道，以及 180、192、512、1024 像素图标的安全区。ICO 的三帧尺寸、偏移与原始 PNG 内容逐项核对。具体数值见 `validation.json`。

本地预览在 Chromium 的 1100 × 1050 桌面视口与 390 × 844 手机视口完成检查，9 张引用图片均成功加载，页面宽度与视口相符。圆形裁切、圆角裁切、透明背景及小尺寸排列已通过桌面截图目视检查。

应用接入与真机安装验证为后续事项。当前资产属于用户选定方案的栅格导出。

在本目录执行文件校验。

```sh
shasum -a 256 -c SHA256SUMS
```

# JSON Schema 与 Ajv

[候选目录](<目录.md>) · [跨模块契约](<../架构与设计/A方案全景/跨模块契约.md>)

日期：2026-11-01。状态：**已初评，选为验证基线**；未安装或运行。采用 [JSON Schema 2020-12](<https://json-schema.org/draft/2020-12>) 作为领域协议方言，[Ajv 8.20.0](<https://github.com/ajv-validator/ajv/blob/v8.20.0/package.json>) 为校验候选（MIT）。

优先复用成熟校验器。仅编译随插件发布的受信 schema；使用2020-12对应实现与严格模式，不隐式补默认值、转换类型或删掉未知字段。模型不能提供动态schema、正则或代码。[Ajv官方说明](<https://ajv.js.org/json-schema.html>)、[严格模式](<https://ajv.js.org/strict-mode.html>)。

DSH工具参数接受的schema子集单独适配，不能声称任意2020-12规范可原样注册。格式正确也不能替代主体认证、授权、CAS、预算或领域不变量。验证 V01/V04/V06 覆盖字段兼容、恶意输入与权限检查；版本升级重跑冻结用例。

具体复用依据见[核心证据](<../research/2026-11-01-完整架构/核心与视图.md>)和[契约标准](<../research/2026-11-01-完整架构/契约标准.md>)。本轮未实现运行协议。

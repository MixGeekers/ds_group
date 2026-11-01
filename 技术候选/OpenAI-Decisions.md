# OpenAI Decisions API

[候选目录](<目录.md>) · [公司群聊方案](<../架构与设计/A方案全景/公司多人协作与群聊注意力.md>)

- 方向：类型化判断、注意力筛选和工作路由；候选状态：已初评。
- 核查日期：2026-11-01；证据等级：official OpenAI documentation页面阅读，未调用API、未做延迟或质量实测。
- 实施状态：未实施；服务API候选，不是可复制模型权重。

## 核得能力

[官方Decisions指南](https://developers.openai.com/api/docs/guides/decisions)当前列明POST /v1/decisions，仅支持gpt-6-luna；输出predicate、choice、score，可依据文本、图片、JSON和会话证据判断。文件ID、音频和item引用不受支持；不能把附件或语音原样送入就视为已理解。

它是专门的API路径，不应把任意Chat Completions的JSON分类输出都称为这个接口。[创建接口](https://developers.openai.com/api/reference/resources/decisions/methods/create)提供具体输入/问题schema。需要提取任意结构字段或生成解释时，属于不同接口职责。

## 识雨接入建议

用现成SDK/API实现可替换DecisionProvider，程序保留范围裁剪、超时、预算、审计与确定性授权。DSH已有模型路由不证明已经支持Decisions协议；若当前provider只支持普通生成，应补小型具名适配，不新建通用模型框架，也不把服务密钥交给replyer。

分别提出“与当前业务有关吗”“是否包含交期变化”“是否直接请求识雨回答”等窄问题；程序组合答案。处理只读分流和低风险静默，不能直接授权付款、改价或跨供应商披露。把规则、Jev与本候选放到同一中文多轮保留集比较；没有实测前不指定胜者。

官方宣传速度不等于本公司端到端测量；模型概率和confidence需按本地错漏代价校验。平台账户是否有额度、实际模型版本、配额、请求留存/地域与费用仍须实验前核查，本轮没有启用服务或外发业务数据。

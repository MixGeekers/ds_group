import type { Catalog } from "../locale";

const en = {
  createBot: "Create Bot",
  botName: "Bot name",
  chooseName: "Enter a Bot name",
  creating: "Creating",
  retry: "Retry creation",
  pending:
    "The creation result is awaiting confirmation. Retry to check the same request.",
  receiptMissing:
    "The creation receipt is incomplete. Retry to confirm the Bot.",
  connection: "Connect Bot",
  botId: "Bot ID",
  connectInDsh: "Sign in to DSCord in DSH with this account, then bring this Bot online.",
  offline: "Offline",
  online: "Online",
  busy: "Working",
  unavailable: "Unavailable",
  copyId: "Copy Bot ID",
  copied: "Bot ID copied",
  copyFailed: "Select the Bot ID and copy it manually.",
  refreshFailed: "Bot created. The list could not refresh. {error}",
  close: "Close",
  signIn: "Sign in to create a Bot",
} as const;

export const botMessages: Catalog<keyof typeof en> = {
  en,
  "zh-CN": {
    createBot: "创建 Bot",
    botName: "Bot 名称",
    chooseName: "请输入 Bot 名称",
    creating: "创建中",
    retry: "重试创建",
    pending: "创建结果待确认。重试会核对同一次请求。",
    receiptMissing: "创建回执不完整。请重试确认 Bot。",
    connection: "连接 Bot",
    botId: "Bot ID",
    connectInDsh: "在 DSH 的 DSCord 页面登录同一账号，再将此 Bot 上线。",
    offline: "离线",
    online: "在线",
    busy: "工作中",
    unavailable: "不可用",
    copyId: "复制 Bot ID",
    copied: "已复制 Bot ID",
    copyFailed: "请选择 Bot ID 后手动复制。",
    refreshFailed: "Bot 已创建，列表刷新失败。{error}",
    close: "关闭",
    signIn: "登录后创建 Bot",
  },
};

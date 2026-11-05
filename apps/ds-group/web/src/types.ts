export type Locale = "zh-CN" | "en";
export type LocalePreference = Locale | "system";
export type ThemePreference = "system" | "dark" | "light";
export interface Session {
  access_token: string;
  user_id: string;
  device_id?: string;
  identity?: {
    authorityId: string;
    subjectId: string;
    matrixUserId: string;
    kind: "human";
  };
  home?: { serverName: string; coreUrl: string | null; matrixUrl: string };
  binding?: import("./session").SessionBinding;
}
export interface Participant {
  id: string;
  name: string;
  localpart?: string;
  kind: "human" | "bot";
  ownerId?: string;
  status?: string;
}
export interface AccountProfile {
  user: Participant;
  ownedBots: Participant[];
  identity?: Session["identity"];
  home?: Session["home"];
}
export interface Role {
  id: string;
  name: string;
  color: string;
  memberIds: string[];
  mentionable: boolean;
  canMention?: boolean;
}
export interface Room {
  roomId: string;
  name: string;
  kind: "group" | "direct";
  participantIds: string[];
  topic?: string;
  unreadCount?: number;
  mentionCount?: number;
  status?: string;
  joinResults?: { participantId: string; status: string }[];
  serverId?: string;
  spaceId?: string;
  membership?: "joined" | "invited" | "left";
  permissions?: {
    inviteMembers?: boolean;
    manageRoles?: boolean;
    sendMessages?: boolean;
  };
}
export interface Mentionables {
  members: Participant[];
  roles: Role[];
  canMentionEveryone: boolean;
  canMentionHere: boolean;
}
export interface Mentions {
  users: string[];
  roles: string[];
  everyone: boolean;
  here: boolean;
  roleLabels?: Record<string, string>;
  replyUserId?: string;
  roleUsers?: string[];
  everyoneUsers?: string[];
  hereUsers?: string[];
}
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  contentUri?: string;
  createdAt?: string;
}
export interface MessageMetadata {
  to?: string[];
  attachments?: Attachment[];
  mentions?: Mentions;
  replyTo?: string;
  taskId?: string;
  kind?: string;
}
export interface ChatEvent {
  event_id: string;
  room_id?: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: {
    body: string;
    msgtype?: string;
    "org.ds_group"?: MessageMetadata;
    "m.mentions"?: { user_ids?: string[]; room?: boolean };
    "m.relates_to"?: { "m.in_reply_to"?: { event_id: string } };
  };
}
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export interface WorkTask {
  requestId: string;
  taskId?: string;
  botId: string;
  roomId: string;
  eventId: string;
  status: TaskStatus;
  stage: string;
  summary: string;
  artifacts: Attachment[];
  toolCalls: number;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface BotNode {
  id: string;
  botId: string;
  name: string;
  status: string;
  engine?: string;
  processed?: number;
  pending?: number;
  model?: string;
  lastError?: string | null;
}
export interface ServerStatus {
  nodes: BotNode[];
  core?: { name?: string; engine?: string; roomId?: string };
  budget?: {
    used?: number;
    limit?: number | null;
    remaining?: number | null;
    model?: string;
  };
}
export interface Bootstrap {
  name: string;
  roomId: string | null;
  roomName?: string;
  homeserverUrl?: string;
  serverName?: string;
  participants: Participant[];
  demoLogin?: boolean;
  registration?: { enabled: boolean; mode: "open" | "closed" };
  mode?: string;
  attachments?: { maxBytes: number; maxPerMessage: number };
}
export interface NotificationPreferences {
  mode: "all" | "mentions" | "nothing";
  muted: boolean;
  suppressEveryone: boolean;
  suppressRoles: boolean;
}
export type InboxEvent = ChatEvent & { read: boolean; mentionKinds: string[] };
export interface InboxResult {
  events: InboxEvent[];
  unreadCount: number;
  mentionCount: number;
}
export interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  timeout?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
export type Api = <T>(route: string, options?: RequestOptions) => Promise<T>;
export type RawRequest = (
  route: string,
  options?: RequestInit & { auth?: boolean },
) => Promise<Response>;
export interface OutgoingMessage {
  body: string;
  mentions: Mentions;
  attachments: string[];
  transactionId: string;
  replyTo?: string;
  replyMention?: boolean;
}
export interface ReplyTarget {
  eventId: string;
  senderName: string;
  body: string;
}
export interface ComposerHandle {
  insertMention(member: Participant): void;
  focus(): void;
}
export interface PwaHandle {
  refresh(): Promise<void>;
  beforeIdentityChange(nextUserId: string): Promise<void>;
  destroy?(): void;
}
export type SettingsTab = "account" | "appearance" | "notifications";

declare global {
  interface Window {
    DSGroupTheme: {
      getPreference(): ThemePreference;
      getResolvedTheme(): "dark" | "light";
      setPreference(value: ThemePreference): void;
    };
  }
}

export interface Partner { serverName: string; name: string; enabled: boolean; publicUrl?: string }
export interface Admission { id: string; name: string; kind: "human" | "bot"; enabled: boolean; ownerId?: string }
export interface Rule { roomId: string; authority: string; name: string; enabled: boolean; memberIds: string[]; botIds: string[]; tools: string[] }
export interface BotPolicy { botId: string; enabled: boolean; roomIds: string[]; requesterIds: string[]; tools: string[]; canDelegate: boolean }
export interface Policy {
  schemaVersion: 1; serverName: string; revision: number; partners: Partner[]; members: Admission[]; rooms: Rule[]; botPolicies: BotPolicy[];
  settings: { registrationMode: "open" | "closed" | null; maxUploadBytes: number | null };
}
export interface Administrator { username: string; role: "owner" | "operator" | "auditor"; enabled: boolean; createdAt: number }
export interface ManagementSession { access_token: string; administrator: Pick<Administrator, "username" | "role">; expiresAt: number }
export interface Application {
  savedRevision: number; livePolicyObserved: boolean; restartRequired: boolean; configurationWritable: boolean;
  guard: null | { liveRevision: number; bootId: string; loadedPartners: string[]; observedAt: number; error: string | null };
  application: null | { revision: number; status: string; configuration: { status: string; error?: string }; rooms: { roomId: string; status: string; error?: string; bans: { id: string; status: string; error?: string }[] }[] };
}
export interface Overview {
  serverName: string; publicUrl?: string; homeserverUrl?: string; initialRoomId: string; startedAt: number; application: Application;
  storage: { backend: string; bucket?: string; prefix?: string; files: { filename: string; bytes: number }[]; backup: string };
}

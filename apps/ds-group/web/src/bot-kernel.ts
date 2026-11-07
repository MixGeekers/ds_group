export type ParticipationMode = "mention" | "shadow" | "natural";
export type BotActivity = "listening" | "waiting" | "working" | "speaking";
export interface BotAttention {
  mode: ParticipationMode | null;
  activity?: BotActivity;
  status?: string | null;
  provider: {
    id?: string | null;
    model?: string | null;
    configured: boolean;
    available?: boolean | null;
    health?: "unknown" | "ok" | "error" | "unconfigured";
  } | null;
  queue?: { pending?: number; waiting?: number; evaluating?: number; errors?: number } | null;
  lastDecision?: { action: "LISTEN" | "WAIT" | "SPEAK"; at?: number; outcome?: string } | null;
}
export interface BotKernelView {
  online?: boolean;
  updatedAt?: number | null;
  desiredAttention?: AttentionReceipt | null;
  runtime: { id: string; version?: string | null; upstreamVersion?: string | null; available: boolean | null } | null;
  attention: BotAttention | null;
  work: { status: string | null; activeTasks: number | null; waiting: number | boolean | null } | null;
  memorySummary: { people: number | null; projects: number | null; pendingReview: number | null } | null;
}
export interface AttentionReceipt {
  mode: ParticipationMode;
  revision: number;
  status: "pending" | "applied";
  applied?: boolean;
  online?: boolean;
}
export type MemoryProfileKind = "person" | "project";
export interface MemoryProfileItem {
  id: string;
  name: string;
  kind: MemoryProfileKind;
  aliases?: string[];
  currentCount?: number;
  historyCount?: number;
  scopes?: string[];
}
export interface MemorySource {
  id: string;
  revision?: number;
  authorId?: string;
  authorKind?: string;
  eventId?: string;
  roomId?: string;
  timestamp?: number | null;
  digest?: string;
}
export interface MemoryClaim {
  id: string;
  revision?: number;
  text: string;
  claimState?: "statement" | "proposal" | "confirmed" | "uncertain";
  kind?: "stated" | "reported" | "observation" | "inference" | "legacy";
  saidBy?: string;
  scope?: string;
  sources?: MemorySource[];
  sourceRefs?: { id: string; revision?: number }[];
  conflicts?: string[];
  derivation?: string;
}
export interface MemoryProfile {
  kind: MemoryProfileKind;
  id: string;
  identity: MemoryProfileItem;
  view: {
    currentClaims?: MemoryClaim[];
    preferences?: MemoryClaim[];
    projectFacts?: MemoryClaim[];
    changes?: MemoryClaim[];
    recentSources?: MemorySource[];
    historyGaps?: unknown[];
    knowledgeBoundary?: string | { text?: string };
    budget?: { maxChars?: number; usedChars?: number; omitted?: Record<string, number> };
  };
}

/** Transport status and attention are separate: a waiting Bot is still online. */
export function connectionLabel(status: string | undefined) {
  if (["online", "idle", "ready", "connected", "listening", "waiting"].includes(status ?? "")) return "online";
  if (["running", "thinking", "busy", "processing", "starting", "working", "speaking"].includes(status ?? "")) return "busy";
  if (["failed", "error", "unavailable"].includes(status ?? "")) return "unavailable";
  if (status === "offline" || status === "disconnected") return "offline";
  return "unknown";
}

export function kernelActivity(view: BotKernelView | null): BotActivity | "unknown" {
  const value = view?.attention?.activity ?? view?.attention?.status;
  if (["listening", "waiting", "working", "speaking"].includes(value ?? "")) return value as BotActivity;
  if (typeof view?.work?.activeTasks === "number" && view.work.activeTasks > 0) return "working";
  if (view?.work?.waiting === true || typeof view?.work?.waiting === "number" && view.work.waiting > 0) return "waiting";
  return "unknown";
}

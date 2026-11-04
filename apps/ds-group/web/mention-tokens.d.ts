import type { ChatEvent, Mentions, Participant, Role } from "./src/types";
export interface MentionToken {
  start: number;
  end: number;
  kind: "user" | "role" | "everyone" | "here";
  id?: string;
}
export function parseMentionTokens(
  body: string,
): Mentions & { tokens: MentionToken[] };
export function mentionKindsFor(
  event: ChatEvent,
  userId: string | undefined,
): string[];
export function displayMentionText(
  body: string,
  participants?: Participant[],
  roles?: Role[],
): string;

import type { Mentionables, Mentions, Participant } from "./src/types";
export interface MentionCandidate {
  id?: string;
  name: string;
  kind: "member" | "user" | "role" | "everyone" | "here";
  memberKind?: Participant["kind"];
  localpart?: string;
  status?: string;
  color?: string;
}
export interface MentionValue {
  body: string;
  mentions: Mentions;
}
export interface MentionEditor {
  getValue(): MentionValue;
  setValue(value: string | MentionValue): void;
  clear(): void;
  focus(): void;
  setDisabled(disabled: boolean): void;
  setPlaceholder(text: string): void;
  refresh(): void;
  insertMention(item: MentionCandidate): void;
  destroy(): void;
}
export function createMentionEditor(options: {
  element: HTMLElement;
  popup: HTMLElement;
  getMentionables(): Mentionables;
  getLabels?(): {
    suggestions?: string;
    mention?: string;
    role?: string;
    everyone?: string;
    here?: string;
    online?: string;
    offline?: string;
  };
  onChange?(value: MentionValue): void;
  onSubmit?(): void;
  onFiles?(files: File[]): void;
  maxLength?: number;
}): MentionEditor;

import type { Attachment, Session } from "./src/types";

export interface UploadState {
  uploadId: string;
  name: string;
  mimeType: string;
  size: number;
  status: "queued" | "uploading" | "ready" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  attachment: Attachment | null;
}
export interface AttachmentManager {
  addFiles(files: Iterable<File> | FileList): void;
  getReady(): Attachment[];
  getState(): UploadState[];
  hasPending(): boolean;
  exportDraft(): Attachment[];
  restore(descriptors: Attachment[]): void;
  clear(): void;
  cancelAll(): void;
  setLimits(limits: { maxBytes: number; maxFiles: number }): void;
  setContext(key: string): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}
export interface AttachmentPreview {
  url: string;
  attachment: Attachment;
  kind: "image" | "pdf" | "text" | null;
  dispose(): void;
}
export function createAttachmentManager(options: {
  container: HTMLElement;
  input: HTMLInputElement;
  getSession(): Session | null;
  onChange?(files: UploadState[]): void;
  onError?(message: string): void;
  maxBytes?: number;
  maxFiles?: number;
}): AttachmentManager;
export function renderAttachmentCard(
  attachment: Attachment,
  options: {
    getSession(): Session | null;
    onPreview?(preview: AttachmentPreview): void | Promise<void>;
    onError?(message: string): void;
  },
): HTMLElement & { dispose(): void };
export function attachmentPreviewKind(
  attachment: Attachment,
): AttachmentPreview["kind"];
export function formatFileSize(value: number): string;

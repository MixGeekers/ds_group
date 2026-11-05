import type { Api, PwaHandle, Session } from "./src/types";

export interface PwaOptions {
  request: Api;
  getSession(): Session | null;
  getOwnerScope?(): string;
  homeCoreUrl?: string;
  onOpenRoom(navigation: {
    roomId: string;
    eventId?: string;
    userId?: string;
    homeCoreUrl?: string;
    authorityId?: string | null;
  }): void | Promise<void>;
}
export function initializePwa(options: PwaOptions): PwaHandle;

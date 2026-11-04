import type { Api, PwaHandle, Session } from "./src/types";

export interface PwaOptions {
  request: Api;
  getSession(): Session | null;
  onOpenRoom(navigation: {
    roomId: string;
    eventId?: string;
  }): void | Promise<void>;
}
export function initializePwa(options: PwaOptions): PwaHandle;

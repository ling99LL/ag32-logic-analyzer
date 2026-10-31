import type { Ag32DesktopApi } from "../shared/api.js";

declare global {
  interface Window {
    ag32?: Ag32DesktopApi & {
      openPath?(target: string, reveal?: boolean): Promise<string>;
    };
  }
}

export {};

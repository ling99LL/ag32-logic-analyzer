import type { Ag32DesktopApi } from "../shared/api.js";
import { createMockApi } from "./mock.js";

export type RendererApi = Ag32DesktopApi & {
  openPath?(target: string, reveal?: boolean): Promise<string>;
};

export const api: RendererApi = window.ag32 ?? createMockApi();
export const isMockMode = !window.ag32;

if (isMockMode) {
  window.__ag32MockInvoke = api.invoke.bind(api);
}

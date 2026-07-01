import Electrobun, { Electroview } from "electrobun/view";

import {
  installDirectoryBridge,
  normalizeDirectorySelection,
  type NativeDirectoryBridgeTarget,
} from "./nativeBridge.ts";

type ElectrobunWindow = Window &
  NativeDirectoryBridgeTarget & {
    __electrobun?: unknown;
  };

export function installElectrobunBridge(target: ElectrobunWindow = window): void {
  if (!target.__electrobun) return;

  const rpc = Electroview.defineRPC<any>({
    maxRequestTime: 600000,
    handlers: {
      requests: {},
      messages: {},
    },
  });
  const electrobun = new Electrobun.Electroview({ rpc });

  installDirectoryBridge(target, async () => {
    const selection = await (electrobun.rpc as any)?.request.selectDirectory();
    return Array.isArray(selection) ? normalizeDirectorySelection(selection) : (selection ?? null);
  });
}

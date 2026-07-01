export interface NativeDirectoryBridge {
  selectDirectory: () => Promise<string | null>;
}

export interface NativeDirectoryBridgeTarget {
  electronAPI?: Partial<NativeDirectoryBridge> & object;
}

export function normalizeDirectorySelection(selection: string[] | null | undefined): string | null {
  return selection?.find((item) => item.trim() !== "") ?? null;
}

export function installDirectoryBridge(
  target: NativeDirectoryBridgeTarget,
  selectDirectory: () => Promise<string | null>,
): void {
  target.electronAPI = {
    ...target.electronAPI,
    selectDirectory,
  };
}

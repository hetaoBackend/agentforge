export class BrowserWindow {
  constructor(options: Record<string, unknown>);
}

export class BrowserView {
  static defineRPC<T = unknown>(config: Record<string, unknown>): T;
}

export const Utils: {
  openFileDialog(options?: {
    startingFolder?: string;
    allowedFileTypes?: string;
    canChooseFiles?: boolean;
    canChooseDirectory?: boolean;
    allowsMultipleSelection?: boolean;
  }): Promise<string[]>;
};

export const app: {
  on(name: string, handler: (payload: unknown) => void): () => void;
  quit(): void;
};

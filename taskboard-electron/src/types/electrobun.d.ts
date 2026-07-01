export interface ElectrobunConfig {
  app: {
    name: string;
    identifier: string;
    version: string;
    description?: string;
  };
  runtime?: Record<string, unknown>;
  build?: Record<string, unknown>;
  scripts?: Record<string, string>;
  release?: Record<string, unknown>;
}

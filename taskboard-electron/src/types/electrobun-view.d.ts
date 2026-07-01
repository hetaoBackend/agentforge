export class Electroview<T = unknown> {
  rpc?: T;
  constructor(config: { rpc: T });
  static defineRPC<T = unknown>(config: Record<string, unknown>): T;
}

declare const Electrobun: {
  Electroview: typeof Electroview;
};

export default Electrobun;

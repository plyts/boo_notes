export interface Exchange {
  ready: Promise<void>;
  readonly url: string;
  close(): Promise<void>;
}

export function startExchange(opts?: { port?: number; env?: Record<string, string | undefined> }): Exchange;

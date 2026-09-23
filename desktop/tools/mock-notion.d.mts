export const PARENT_PAGE_ID: string;

export interface MockBlockView {
  type: string;
  text: string;
  children?: MockBlockView[];
}

export interface MockNotion {
  state: {
    pages: Map<string, Record<string, any>>;
    databases: Map<string, Record<string, any>>;
    blocks: Map<string, Record<string, any>>;
    uploads: Map<string, Record<string, any>>;
    requests: Array<{ method: string; path: string; body: any }>;
    rateLimitNext: number;
  };
  ready: Promise<void>;
  readonly url: string;
  seedPage(id: string, title: string): void;
  pageContent(pageId: string): MockBlockView[] | null;
  close(): Promise<void>;
}

export function startMockNotion(opts?: { port?: number; token?: string; log?: (m: string) => void }): MockNotion;

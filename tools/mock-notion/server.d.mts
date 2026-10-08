export const PARENT_PAGE_ID: string;
export const OAUTH_CLIENT: { clientId: string; clientSecret: string };

export interface MockBlockView {
  type: string;
  text: string;
  checked?: boolean;
  toggleable?: boolean;
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
    revoked: string[];
  };
  ready: Promise<void>;
  readonly url: string;
  seedPage(id: string, title: string): void;
  expireToken(): void;
  readonly token: string;
  pageContent(pageId: string): MockBlockView[] | null;
  titleOf(pageId: string): string;
  close(): Promise<void>;
}

export function startMockNotion(opts?: { port?: number; token?: string; log?: (m: string) => void; oauth?: { clientId: string; clientSecret: string } }): MockNotion;

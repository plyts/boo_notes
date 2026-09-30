// The exchange of « Connecter Notion » (worker.mjs) served by Node: tests, and local
// development before deploying it.
//   NOTION_CLIENT_ID=… NOTION_CLIENT_SECRET=… node tools/notion-oauth/server.mjs [--port 43119]
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.mjs';

export function startExchange({ port = 0, env = process.env } = {}) {
  let base = '';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`${base}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).filter((e) => typeof e[1] === 'string'),
        ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
  const ready = new Promise((r) => server.listen(port, '127.0.0.1', r)).then(() => {
    base = `http://127.0.0.1:${server.address().port}`;
  });
  return {
    ready,
    get url() {
      return base;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const exchange = startExchange({ port: i > -1 ? Number(process.argv[i + 1]) : 43119 });
  await exchange.ready;
  console.log(`[notion-oauth] ${exchange.url}/token`);
}

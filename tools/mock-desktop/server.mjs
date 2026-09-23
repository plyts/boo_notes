// Mock of the Boo Notes desktop app (protocol v1, see docs/PROTOCOL.md).
// Usage: npm run mock:desktop -- [--port 43117] [--token secret] [--data ./.boo-desktop-data]
import { WebSocketServer } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const slug = (id) => id.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '');

export function startMockDesktop({ port = 43117, token = '', dataDir = '.boo-desktop-data', log = () => {} } = {}) {
  const root = resolve(dataDir);
  const received = { notes: new Map(), assets: new Map(), exports: [], active: null, clients: 0 };
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // Only browser extensions may connect (a web page cannot forge this Origin).
    verifyClient: ({ origin }) => !origin || /^(chrome|moz)-extension:\/\//.test(origin),
  });

  wss.on('connection', (ws) => {
    received.clients++;
    let authed = false;
    const send = (msg) => ws.send(JSON.stringify(msg));
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        if (msg.protocol !== 1) {
          send({ type: 'error', code: 'protocol', message: 'Protocole non supporté' });
          ws.close(4000);
          return;
        }
        if (token && msg.token !== token) {
          send({ type: 'error', code: 'unauthorized', message: 'Jeton invalide' });
          ws.close(4001);
          return;
        }
        authed = true;
        send({ type: 'welcome', protocol: 1, app: { name: 'Boo Desktop (mock)', version: '0.0.1' } });
        log(`client connecté (${msg.client?.name} ${msg.client?.version})`);
        return;
      }
      if (!authed) {
        send({ type: 'error', code: 'unauthorized' });
        ws.close(4001);
        return;
      }
      switch (msg.type) {
        case 'ping':
          send({ type: 'pong' });
          break;
        case 'asset.put': {
          const file = normalize(join(root, msg.path));
          if (!msg.path.startsWith('assets/') || !file.startsWith(root)) break;
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, Buffer.from(msg.data, 'base64'));
          received.assets.set(msg.path, { mime: msg.mime, width: msg.width, height: msg.height });
          log(`capture reçue : ${msg.path}`);
          send({ type: 'asset.ack', path: msg.path });
          break;
        }
        case 'note.upsert': {
          await mkdir(root, { recursive: true });
          await writeFile(join(root, `${slug(msg.note.id)}.md`), msg.portableMarkdown ?? msg.note.markdown);
          received.notes.set(msg.note.id, msg.note);
          log(`note ${msg.note.id} rev ${msg.note.rev}`);
          send({ type: 'ack', noteId: msg.note.id, rev: msg.note.rev });
          break;
        }
        case 'export':
          received.exports.push(msg);
          send({
            type: 'export.result',
            requestId: msg.requestId,
            ok: true,
            message: msg.target === 'notion' ? 'Envoyé vers Notion (simulé)' : `Exporté dans ${root}`,
          });
          break;
        case 'player.active':
          received.active = msg.player;
          break;
        default:
          break;
      }
    });
  });

  const ready = new Promise((r) => wss.on('listening', r));
  return {
    wss,
    received,
    ready,
    get port() {
      return wss.address().port;
    },
    close: () =>
      new Promise((r) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => r());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const server = startMockDesktop({
    port: Number(arg('port', 43117)),
    token: arg('token', process.env.BOO_TOKEN ?? ''),
    dataDir: arg('data', '.boo-desktop-data'),
    log: (m) => console.log(`[boo-desktop] ${m}`),
  });
  await server.ready;
  console.log(`[boo-desktop] en écoute sur ws://127.0.0.1:${server.port}`);
}

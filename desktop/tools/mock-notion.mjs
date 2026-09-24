// In-memory imitation of the Notion REST API endpoints used by Boo Notes Desktop, with
// the same validation rules that matter (auth, version header, 100 children, 2000
// characters per text, nesting, rate limiting). Used by the tests and for local development:
//   npm run mock:notion -- [--port 43118] [--token secret_test]
// then set NOTION_API_BASE=http://127.0.0.1:43118 before starting the app.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARENT_PAGE_ID = '11111111-1111-4111-8111-111111111111';

const compact = (id) => String(id).replace(/-/g, '').toLowerCase();

export function startMockNotion({ port = 0, token = 'secret_test', log = () => {} } = {}) {
  const state = {
    pages: new Map(),
    databases: new Map(),
    blocks: new Map(),
    uploads: new Map(),
    requests: [],
    /** Next N requests answer 429 (Retry-After: 0). */
    rateLimitNext: 0,
  };
  let base = '';

  const seedPage = (id, title) => {
    state.pages.set(compact(id), {
      object: 'page',
      id,
      url: `https://www.notion.so/${compact(id)}`,
      parent: { type: 'workspace', workspace: true },
      properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
      children: [],
      archived: false,
      in_trash: false,
    });
  };
  seedPage(PARENT_PAGE_ID, 'Mes cours');

  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

  function checkRichText(items, where) {
    for (const rt of items ?? []) {
      if (rt?.type === 'mention') {
        const id = rt.mention?.page?.id;
        if (!id || !state.pages.has(compact(id))) throw fail(400, 'validation_error', `Could not find page with ID: ${id}.`);
        continue;
      }
      const content = rt?.text?.content ?? '';
      if (content.length > 2000) throw fail(400, 'validation_error', `${where}.text.content.length should be ≤ 2000`);
      const url = rt?.text?.link?.url;
      if (url !== undefined && url !== null) {
        try {
          const u = new URL(url);
          if (!/^(https?|mailto):$/.test(u.protocol)) throw new Error();
        } catch {
          throw fail(400, 'validation_error', `Invalid URL for link: ${url}`);
        }
      }
    }
    if ((items ?? []).length > 100) throw fail(400, 'validation_error', `${where} should have ≤ 100 items`);
  }

  function createBlocks(parentId, children, depth = 1) {
    if (!Array.isArray(children)) throw fail(400, 'validation_error', 'children should be an array');
    if (children.length > 100) throw fail(400, 'validation_error', 'body.children.length should be ≤ 100');
    if (depth > 3) throw fail(400, 'validation_error', 'Too many levels of nesting in children');
    return children.map((spec, i) => {
      const type = spec.type;
      if (!type || !spec[type]) throw fail(400, 'validation_error', 'block type missing');
      const data = structuredClone(spec[type]);
      // As the API: a bookmark / embed takes its `url` itself, a media its `external.url` (or an upload).
      const need = (value, path) => {
        if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value))
          throw fail(400, 'validation_error', `body.children[${i}].${type}.${path} should be ${value === undefined ? 'defined' : 'a valid URL'}, instead was \`${JSON.stringify(value) ?? 'undefined'}\`.`);
      };
      if (type === 'bookmark' || type === 'embed') need(data.url, 'url');
      if (['image', 'video', 'file', 'pdf', 'audio'].includes(type) && data.type === 'external') need(data.external?.url, 'external.url');
      checkRichText(data.rich_text, `${type}.rich_text`);
      checkRichText(data.caption, `${type}.caption`);
      if (type === 'image' && data.type === 'file_upload') {
        const up = state.uploads.get(compact(data.file_upload?.id));
        if (!up || up.status !== 'uploaded') throw fail(400, 'validation_error', 'File upload is not uploaded');
        up.attached = (up.attached ?? 0) + 1;
      }
      const nested = data.children;
      delete data.children;
      const id = randomUUID();
      const block = { object: 'block', id, type, [type]: data, parentId, children: [], archived: false, has_children: false };
      state.blocks.set(compact(id), block);
      if (nested) {
        block.children = createBlocks(id, nested, depth + 1).map((b) => b.id);
        block.has_children = block.children.length > 0;
      }
      return block;
    });
  }

  function container(id) {
    return state.pages.get(compact(id)) ?? state.blocks.get(compact(id));
  }

  const publicBlock = (b) => {
    const { parentId, children, ...rest } = b;
    void parentId;
    void children;
    return rest;
  };

  function checkProperties(db, properties) {
    for (const name of Object.keys(properties ?? {})) {
      if (!db.properties[name]) throw fail(400, 'validation_error', `${name} is not a property that exists.`);
      const value = properties[name];
      if (value.title) checkRichText(value.title, `${name}.title`);
      if (value.rich_text) checkRichText(value.rich_text, `${name}.rich_text`);
      if (value.relation) {
        if (!db.properties[name].relation) throw fail(400, 'validation_error', `${name} is not a relation.`);
        for (const r of value.relation) {
          if (!state.pages.has(compact(r.id))) throw fail(400, 'validation_error', `Relation page ${r.id} not found.`);
        }
      }
    }
  }

  /** Two-way relations: the synced property of the target database lists the pages pointing to it. */
  function backlinksOf(page) {
    const db = page.parent?.database_id ? state.databases.get(compact(page.parent.database_id)) : null;
    if (!db) return {};
    const out = {};
    for (const [name, def] of Object.entries(db.properties)) {
      const synced = def.relation?.dual_property?.synced_property_name;
      if (!synced) continue;
      const sources = [...state.pages.values()].filter(
        (p) => !p.archived && !p.in_trash && (p.properties[name]?.relation ?? []).some((r) => compact(r.id) === compact(page.id)),
      );
      out[synced] = { relation: sources.map((p) => ({ id: p.id })) };
    }
    return out;
  }

  async function route(method, path, body) {
    let m;
    if (method === 'GET' && path === '/v1/users/me')
      return { object: 'user', id: 'bot-1', type: 'bot', name: 'Boo Notes', bot: { workspace_name: 'Espace de test' } };

    if ((m = /^\/v1\/pages\/([\w-]+)$/.exec(path))) {
      const page = state.pages.get(compact(m[1]));
      if (!page) throw fail(404, 'object_not_found', `Could not find page with ID: ${m[1]}.`);
      if (method === 'GET') return publicPage(page);
      if (method === 'PATCH') {
        if (page.archived || page.in_trash) throw fail(400, 'validation_error', 'Can’t edit page that is archived.');
        const db = page.parent?.database_id ? state.databases.get(compact(page.parent.database_id)) : null;
        if (db && body.properties) checkProperties(db, body.properties);
        Object.assign(page.properties, body.properties ?? {});
        if (body.icon) page.icon = body.icon;
        if (typeof body.archived === 'boolean') page.archived = body.archived;
        if (typeof body.in_trash === 'boolean') page.in_trash = body.in_trash;
        return publicPage(page);
      }
    }
    if (method === 'POST' && path === '/v1/pages') {
      const dbId = body.parent?.database_id;
      const db = dbId && state.databases.get(compact(dbId));
      if (!db || db.archived) throw fail(404, 'object_not_found', `Could not find database with ID: ${dbId}.`);
      checkProperties(db, body.properties);
      const id = randomUUID();
      const page = {
        object: 'page',
        id,
        url: `https://www.notion.so/${compact(id)}`,
        parent: { type: 'database_id', database_id: db.id },
        properties: structuredClone(body.properties ?? {}),
        icon: body.icon,
        children: [],
        archived: false,
        in_trash: false,
      };
      state.pages.set(compact(id), page);
      if (body.children) page.children = createBlocks(id, body.children).map((b) => b.id);
      return publicPage(page);
    }

    if (method === 'POST' && path === '/v1/databases') {
      const parentId = body.parent?.page_id;
      const parent = parentId && state.pages.get(compact(parentId));
      if (!parent) throw fail(404, 'object_not_found', `Could not find page with ID: ${parentId}.`);
      if (!Object.values(body.properties ?? {}).some((p) => p.title))
        throw fail(400, 'validation_error', 'Database needs a title property');
      for (const [name, def] of Object.entries(body.properties)) {
        if (def.status) throw fail(400, 'validation_error', `Status property ${name} can’t be created via the API`);
      }
      const id = randomUUID();
      const db = {
        object: 'database',
        id,
        url: `https://www.notion.so/${compact(id)}`,
        parent: { type: 'page_id', page_id: parentId },
        title: body.title,
        properties: structuredClone(body.properties),
        is_inline: Boolean(body.is_inline),
        archived: false,
        in_trash: false,
      };
      state.databases.set(compact(id), db);
      return db;
    }
    if ((m = /^\/v1\/databases\/([\w-]+)\/query$/.exec(path)) && method === 'POST') {
      const db = state.databases.get(compact(m[1]));
      if (!db) throw fail(404, 'object_not_found', `Could not find database with ID: ${m[1]}.`);
      const f = body.filter;
      const results = [...state.pages.values()].filter((p) => {
        if (compact(p.parent?.database_id ?? '') !== compact(db.id) || p.archived || p.in_trash) return false;
        if (!f) return true;
        const prop = p.properties[f.property];
        const text = (prop?.rich_text ?? prop?.title ?? []).map((r) => r.text?.content ?? '').join('');
        if (f.rich_text?.equals !== undefined) return text === f.rich_text.equals;
        if (f.title?.equals !== undefined) return text === f.title.equals;
        return true;
      });
      return { object: 'list', results: results.slice(0, body.page_size ?? 100).map(publicPage), has_more: false, next_cursor: null };
    }
    if ((m = /^\/v1\/databases\/([\w-]+)$/.exec(path))) {
      const db = state.databases.get(compact(m[1]));
      if (!db) {
        if (state.pages.has(compact(m[1])))
          throw fail(400, 'validation_error', `Provided ID ${m[1]} is a page, not a database.`);
        throw fail(404, 'object_not_found', `Could not find database with ID: ${m[1]}.`);
      }
      if (method === 'GET') return db;
      if (method === 'PATCH') {
        for (const [name, def] of Object.entries(body.properties ?? {})) {
          db.properties[name] = structuredClone(def);
          const synced = def.relation?.dual_property?.synced_property_name;
          if (synced) {
            const target = state.databases.get(compact(def.relation.database_id));
            if (!target) throw fail(400, 'validation_error', 'Relation database not found');
            target.properties[synced] = { relation: { database_id: db.id, type: 'dual_property', dual_property: { synced_property_name: name } } };
          }
        }
        if (typeof body.archived === 'boolean') db.archived = body.archived;
        return db;
      }
      if (method === 'POST') throw fail(400, 'invalid_request_url', 'Use /query');
    }

    if ((m = /^\/v1\/blocks\/([\w-]+)\/children$/.exec(path))) {
      const parent = container(m[1]);
      if (!parent) throw fail(404, 'object_not_found', `Could not find block with ID: ${m[1]}.`);
      if (method === 'PATCH') {
        if (parent.archived) throw fail(400, 'validation_error', 'Can’t edit block that is archived.');
        const created = createBlocks(parent.id, body.children);
        parent.children.push(...created.map((b) => b.id));
        return { object: 'list', results: created.map(publicBlock), has_more: false, next_cursor: null };
      }
      if (method === 'GET') {
        const all = parent.children.map((id) => state.blocks.get(compact(id))).filter((b) => b && !b.archived);
        return { object: 'list', results: all.map(publicBlock), has_more: false, next_cursor: null };
      }
    }
    if ((m = /^\/v1\/blocks\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
      const block = state.blocks.get(compact(m[1]));
      if (!block) throw fail(404, 'object_not_found', `Could not find block with ID: ${m[1]}.`);
      if (block.archived) throw fail(400, 'validation_error', 'Can’t edit block that is archived.');
      block.archived = true;
      return publicBlock(block);
    }

    if (method === 'POST' && path === '/v1/file_uploads') {
      const id = randomUUID();
      const up = { object: 'file_upload', id, status: 'pending', filename: body.filename, content_type: body.content_type };
      state.uploads.set(compact(id), up);
      return { ...up, upload_url: `${base}/v1/file_uploads/${id}/send` };
    }
    if ((m = /^\/v1\/file_uploads\/([\w-]+)\/send$/.exec(path)) && method === 'POST') {
      const up = state.uploads.get(compact(m[1]));
      if (!up) throw fail(404, 'object_not_found', 'Could not find file upload.');
      if (!body?.multipart || !/name="file"/.test(body.raw)) throw fail(400, 'validation_error', 'file is required');
      up.status = 'uploaded';
      up.size = body.size;
      return { ...up };
    }
    throw fail(400, 'invalid_request_url', `Invalid request URL: ${method} ${path}`);
  }

  function publicPage(page) {
    const { children, ...rest } = page;
    void children;
    return { ...rest, properties: { ...rest.properties, ...backlinksOf(page) } };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const reply = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      let body = {};
      const type = req.headers['content-type'] ?? '';
      if (type.startsWith('multipart/form-data')) body = { multipart: true, raw: raw.toString('latin1'), size: raw.length };
      else if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return reply(400, { object: 'error', status: 400, code: 'invalid_json', message: 'Invalid JSON' });
        }
      }
      state.requests.push({ method: req.method, path: url.pathname, body });
      log(`${req.method} ${url.pathname}`);
      if (req.headers.authorization !== `Bearer ${token}`)
        return reply(401, { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' });
      if (!req.headers['notion-version'])
        return reply(400, { object: 'error', status: 400, code: 'missing_version', message: 'Notion-Version header missing' });
      if (state.rateLimitNext > 0) {
        state.rateLimitNext--;
        return reply(429, { object: 'error', status: 429, code: 'rate_limited', message: 'Rate limited' }, { 'Retry-After': '0' });
      }
      try {
        reply(200, await route(req.method, url.pathname, body));
      } catch (e) {
        reply(e.status ?? 500, { object: 'error', status: e.status ?? 500, code: e.code ?? 'internal_server_error', message: e.message });
      }
    });
  });

  const ready = new Promise((r) => server.listen(port, '127.0.0.1', r)).then(() => {
    base = `http://127.0.0.1:${server.address().port}`;
  });

  function titleOf(id) {
    const page = state.pages.get(compact(id));
    const prop = page && Object.values(page.properties).find((p) => p.title);
    return (prop?.title ?? []).map((r) => r.text?.content ?? '').join('');
  }

  /** Visible (non archived) content of a page, simplified for assertions. */
  function pageContent(pageId) {
    const page = state.pages.get(compact(pageId));
    if (!page) return null;
    const render = (id) => {
      const b = state.blocks.get(compact(id));
      if (!b || b.archived) return null;
      const data = b[b.type];
      const text = (data.rich_text ?? data.caption ?? [])
        .map((r) => (r.type === 'mention' ? `@${titleOf(r.mention.page.id)}` : (r.text?.content ?? '')))
        .join('');
      const out = { type: b.type, text };
      if (b.children.length) out.children = b.children.map(render).filter(Boolean);
      return out;
    };
    return page.children.map(render).filter(Boolean);
  }

  return {
    state,
    ready,
    seedPage,
    pageContent,
    titleOf,
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
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const mock = startMockNotion({
    port: Number(arg('port', 43118)),
    token: arg('token', 'secret_test'),
    log: (m) => console.log(`[mock-notion] ${m}`),
  });
  await mock.ready;
  console.log(`[mock-notion] ${mock.url} — jeton « ${arg('token', 'secret_test')} », page parente ${PARENT_PAGE_ID}`);
}

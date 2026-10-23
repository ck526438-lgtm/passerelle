import { createServer } from 'node:http';
import { tryJson } from '../src/lib/http.js';

/**
 * Serveur de mock : il enregistre chaque requête et répond selon la table
 * `routes`. C'est lui qui joue Meta, OpenAI, Notion et Google dans les tests.
 */
export async function startMock(routes = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw.toString('utf8'), json: tryJson(raw.toString('utf8')) };
      seen.push(entry);
      const handler = routes[`${req.method} ${url.pathname}`] ?? matchPrefix(req.method, url.pathname, routes);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `mock non configuré pour ${req.method} ${url.pathname}` }));
        return;
      }
      const result = handler(entry, seen);
      const status = result?.status ?? 200;
      if (result?.raw !== undefined) {
        res.writeHead(status, { 'content-type': result.contentType ?? 'application/octet-stream' });
        res.end(Buffer.from(result.raw));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result?.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    seen,
    hits: (method, pathContains) => seen.filter((s) => s.method === method && s.path.includes(pathContains)),
    last: (method, pathContains) => [...seen].reverse().find((s) => s.method === method && s.path.includes(pathContains)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function matchPrefix(method, pathname, routes) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    if (pattern.endsWith('*') && pathname.startsWith(pattern.slice(0, -1))) return handler;
  }
  return null;
}

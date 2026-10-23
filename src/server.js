import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifySignature } from './wa/cloud.js';
import { TestWhatsApp } from './wa/test.js';
import { describeActions, actions } from './actions/index.js';
import { capabilities, ROOT } from './config.js';

const WEB = path.join(ROOT, 'web');
const MAX_BODY = 1024 * 1024;

/** Messenger qui n'envoie rien : utilisé par les tests du tableau de bord. */
class RecordingMessenger {
  constructor(real) {
    this.real = real;
    this.provider = real?.provider ?? 'cloud';
    this.sent = [];
  }

  async sendText(chatId, text) {
    const record = { id: `sim-${randomUUID().slice(0, 8)}`, chatId, text };
    this.sent.push(record);
    if (this.sent.length > 50) this.sent.shift();
    return { id: record.id, simulated: true };
  }

  async downloadMedia(token, maxBytes) {
    return this.real.downloadMedia(token, maxBytes);
  }

  async markAsRead() {}
}

const hash = (value) => createHash('sha256').update(String(value ?? '')).digest();

function tokenOk(provided, expected) {
  const a = hash(provided);
  const b = hash(expected);
  return timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Un seul serveur, trois façades :
 *   /webhook/whatsapp  -> Meta (seul endpoint public)
 *   /api/*             -> tableau de bord, protégé par ADMIN_TOKEN
 *   /                  -> UI statique
 */
export function createApp({ config, store, rules, engine, messenger, log }) {
  const startedAt = Date.now();
  const recorder = new RecordingMessenger(messenger);

  const routes = {
    'GET /health': async ({ res }) => send(res, 200, { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), provider: config.wa.provider }),

    'GET /': async ({ res }) => {
      const file = path.join(WEB, 'index.html');
      if (!fs.existsSync(file)) return send(res, 404, 'interface absente');
      return send(res, 200, fs.readFileSync(file, 'utf8'), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    },

    'GET /webhook/whatsapp': async ({ query, res }) => {
      if (config.wa.provider !== 'cloud') return send(res, 404, 'WA_PROVIDER=test : webhook Meta désactivé');
      const challenge = messenger.challengeFor(query);
      return challenge === null ? send(res, 403, 'verify_token incorrect') : send(res, 200, challenge);
    },

    'POST /webhook/whatsapp': async ({ raw, headers, res }) => {
      if (config.wa.provider !== 'cloud') return send(res, 404, 'WA_PROVIDER=test : webhook Meta désactivé');
      if (config.wa.appSecret && !verifySignature(raw, headers['x-hub-signature-256'], config.wa.appSecret)) {
        log.warn('webhook rejeté : signature invalide');
        return send(res, 401, 'signature invalide');
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return send(res, 400, 'JSON invalide');
      }
      // Meta retente en cas de réponse lente : on acquitte, on traite après.
      send(res, 200, { received: true });
      const { messages } = messenger.parse(payload);
      for (const msg of messages) {
        engine.handle(msg).catch((error) => log.error('pipeline en échec', { messageId: msg.id, error: error.message }));
      }
      return undefined;
    },

    'GET /api/state': async ({ res }) => send(res, 200, {
      version: readVersion(),
      provider: config.wa.provider,
      publicBaseUrl: config.publicBaseUrl || null,
      webhookPath: '/webhook/whatsapp',
      connectors: capabilities(config),
      business: config.business,
      rules: { path: rules.path, problems: rules.problems, enabled: rules.rules.length, total: rules.allRules.length },
      actions: describeActions(),
      counts: {
        events: store.events.count(),
        runs: store.runs.count(),
        ok: store.runs.count((r) => r.status === 'ok'),
        errors: store.runs.count((r) => r.status === 'error'),
        contacts: store.contacts.count(),
      },
    }),

    'GET /api/events': async ({ query, res }) => send(res, 200, {
      events: store.events.list({ limit: Number(query.get('limit') ?? 60), where: (e) => (!query.get('kind') || e.kind === query.get('kind')) && (!query.get('chat') || e.chatId === query.get('chat')) }),
      contacts: store.contacts.list({ limit: 50 }),
    }),

    'GET /api/runs': async ({ query, res }) => send(res, 200, { runs: store.runs.list({ limit: Number(query.get('limit') ?? 40), where: (r) => !query.get('rule') || r.ruleId === query.get('rule') }) }),

    'GET /api/rules': async ({ res }) => send(res, 200, { rules: rules.allRules, problems: rules.problems }),

    'PUT /api/rules': async ({ raw, res }) => {
      let document;
      try {
        document = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        return send(res, 400, { error: `JSON invalide: ${error.message}` });
      }
      try {
        rules.save(document);
        return send(res, 200, { ok: true, enabled: rules.rules.length, problems: rules.problems });
      } catch (error) {
        return send(res, 422, { error: error.message });
      }
    },

    /** Le message passe par le vrai pipeline, mais rien n'est envoyé à un client. */
    'POST /api/simulate': async ({ json, res }) => {
      const msg = TestWhatsApp.inbound({
        text: json?.text ?? '',
        type: json?.type ?? (json?.mediaToken ? 'audio' : 'text'),
        chatId: json?.chatId ?? '33600000000',
        contactName: json?.contactName ?? 'Client Test',
        mediaToken: json?.mediaToken ?? (json?.type === 'audio' ? 'simulated-media' : undefined),
      });
      // File d'attente vidée à chaque simulation : l'opérateur ne voit que les
      // réponses produites par CE message (le tableau de bord est mono-poste).
      recorder.sent.length = 0;
      const result = await engine.handle(msg, { messenger: recorder });
      return send(res, 200, { inbound: msg, ...result, replies: recorder.sent.map((s) => s.text), outbox: [...recorder.sent] });
    },

    'POST /api/explain': async ({ json, res }) => {
      const msg = TestWhatsApp.inbound({ text: json?.text ?? '', type: json?.type ?? 'text', chatId: json?.chatId ?? '33600000000' });
      return send(res, 200, { matched: engine.explain(msg) });
    },

    /** Exécute UNE action isolée : le dépannage pas à pas, façon Zapier. */
    'POST /api/test-action': async ({ json, res }) => {
      const def = actions[json?.action];
      if (!def) return send(res, 400, { error: `action inconnue: ${json?.action}` });
      const msg = TestWhatsApp.inbound({ text: json?.sample?.text ?? 'Bonjour, j\'aurais besoin d\'un devis pour la semaine prochaine', type: json?.sample?.type ?? 'text' });
      const scope = { ...engine.buildScope(msg), ...json?.scope };
      try {
        const result = await def.run(json?.step ?? {}, { msg, scope, config, log: log.child?.('test-action') ?? log, store, messenger: recorder, ruleId: 'manual-test', now: () => new Date() });
        return send(res, 200, { ok: true, result, scope });
      } catch (error) {
        return send(res, 200, { ok: false, error: error.message, status: error.status });
      }
    },

    /** Message réel, envoyé pour de vrai. Séparé de /api/simulate pour qu'aucun clic distrait ne parle à un client. */
    'POST /api/send': async ({ json, res }) => {
      if (config.wa.provider !== 'cloud') return send(res, 400, { error: 'WA_PROVIDER=test : rien n\'est réellement envoyé' });
      const text = String(json?.text ?? '').slice(0, 4096);
      if (!text || !json?.chatId) return send(res, 400, { error: 'chatId et text requis' });
      const result = await messenger.sendText(json.chatId, text);
      store.events.append({ kind: 'outbound', messageId: result.id, chatId: String(json.chatId), type: 'text', text, provider: 'cloud', manual: true });
      return send(res, 200, { ok: true, id: result.id });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    try {
      if (!handler) return send(res, 404, { error: `route inconnue: ${key}` });

      const isPublic = key.startsWith('GET /health') || key === 'GET /' || key.includes('/webhook/whatsapp') || key === 'GET /favicon.ico';
      if (config.adminToken && !isPublic && !tokenOk(req.headers['x-passerelle-token'] ?? url.searchParams.get('token'), config.adminToken)) {
        return send(res, 401, { error: 'jeton administrateur requis (en-tête x-passerelle-token)' });
      }

      const needsBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
      const raw = needsBody ? await readBody(req) : Buffer.alloc(0);
      const text = raw.toString('utf8');
      return await handler({
        req,
        res,
        url,
        query: url.searchParams,
        headers: req.headers,
        raw,
        json: text ? safeJson(text) : {},
      });
    } catch (error) {
      log.error('route en échec', { route: key, error: error.message });
      if (!res.headersSent) send(res, 500, { error: error.message });
      return undefined;
    }
  });

  server.requestTimeout = 120_000;
  return server;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

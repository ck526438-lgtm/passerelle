import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHmac, randomUUID, generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { RuleSet } from '../src/rules.js';
import { Engine } from '../src/engine.js';
import { CloudWhatsApp, verifySignature, toMsid } from '../src/wa/cloud.js';
import { createApp } from '../src/server.js';
import { startMock } from './mock-server.js';

const TRANSCRIPT = 'Bonjour, je voudrais un devis pour refaire la salle de bain, vous pouvez passer demain à 14h ?';
const APP_SECRET = 'mock-app-secret';
const ADMIN_TOKEN = 'mock-admin-token';
const PHONE = '33612345678';

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLog; } };

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let mock;
let server;
let config;
let store;
let rules;
let cloud;
let engine;
let port;

const routes = {
  'GET /graph/v23.0/M1': (entry) => ({ json: { url: `http://${entry.headers.host}/media/blob`, mime_type: 'audio/ogg', messaging_product: 'whatsapp' } }),
  'GET /media/*': () => ({ raw: Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]), contentType: 'audio/ogg' }),
  'POST /graph/v23.0/111/messages': () => ({ json: { messages: [{ id: `wamid.OUT${randomUUID().slice(0, 4)}` }], messaging_product: 'whatsapp' } }),
  'POST /v1/audio/transcriptions': () => ({ json: { text: TRANSCRIPT, language: 'fr', duration: 6.4 } }),
  'POST /v1/chat/completions': (entry) => {
    const system = entry.json?.messages?.[0]?.content ?? '';
    const content = system.includes('schéma')
      ? JSON.stringify({ title: 'Devis salle de bain', category: 'devis', contact: 'Awa', note: 'Chantier salle de bain' })
      : JSON.stringify({ answer: 'Bonjour, une réponse générée.' });
    return { json: { model: 'mock-llm', choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 210 } } };
  },
  'POST /notion/v1/pages': () => ({ json: { object: 'page', id: 'page-mock-1', url: 'https://notion.so/page-mock-1' } }),
  'POST /token': () => ({ json: { access_token: 'ya29.mock', expires_in: 3600, token_type: 'Bearer' } }),
  'POST /sheets/v4/spreadsheets/SS/values/Demandes:append': () => ({ json: { updatedRange: 'Demandes!A2:G2', updatedRows: 1, updatedCells: 7 } }),
  'POST /sheets/v4/spreadsheets/SS/values/Leads:append': () => ({ json: { updatedRange: 'Leads!A2:G2', updatedRows: 1 } }),
};

before(async () => {
  mock = await startMock(routes);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-test-'));
  const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'mock@passerelle.iam.gserviceaccount.com', private_key: privateKey });

  config = loadConfig({
    cwd: tmp,
    env: {
      WA_PROVIDER: 'cloud',
      WA_PHONE_NUMBER_ID: '111',
      WA_ACCESS_TOKEN: 'mock-page-token',
      WA_APP_SECRET: APP_SECRET,
      WA_VERIFY_TOKEN: 'mock-verify',
      GRAPH_BASE_URL: `${mock.origin}/graph`,
      OPENAI_API_KEY: 'mock-openai',
      OPENAI_BASE_URL: `${mock.origin}/v1`,
      NOTION_TOKEN: 'mock-notion',
      NOTION_DATABASE_ID: 'db-mock',
      NOTION_BASE_URL: `${mock.origin}/notion`,
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount,
      SHEET_ID: 'SS',
      SHEETS_BASE_URL: `${mock.origin}/sheets`,
      GOOGLE_TOKEN_URL: `${mock.origin}/token`,
      RULES_FILE: path.join(import.meta.dirname, 'fixtures', 'rules.json'),
      DATA_DIR: path.join(tmp, 'data'),
      ADMIN_TOKEN,
      PORT: '0',
      COOLDOWN_SECONDS: '120',
      UTC_OFFSET_MINUTES: '0',
    },
  });

  store = openStore(config.dataDir);
  rules = new RuleSet(config.rulesPath, silentLog).load();
  assert.deepEqual(rules.problems, [], rules.problems.join('\n'));
  cloud = new CloudWhatsApp(config, silentLog);
  engine = new Engine({ config, rules, store, messenger: cloud, log: silentLog });

  server = createApp({ config, store, rules, engine, messenger: cloud, log: silentLog });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
});

const wait = async (predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('attente dépassée : le webhook n\'a pas déclenché le pipeline');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

const webhookBody = (message) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '33700000000', phone_number_id: '111' },
    contacts: [{ profile: { name: 'Awa Diop' }, wa_id: PHONE }],
    messages: [message],
  } }] }],
});

const audioMessage = (id) => ({ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'M1', mime_type: 'audio/ogg', voice: true } });
const textMessage = (id, body) => ({ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });

const postWebhook = async (payload, signature) => {
  const raw = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body: raw,
  });
  return { res, raw };
};

const sign = (raw) => `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const api = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
  ...options,
  headers: { 'content-type': 'application/json', 'x-passerelle-token': ADMIN_TOKEN, ...(options.headers ?? {}) },
});

test('signature HMAC : acceptée, rejetée en cas de altération', () => {
  const raw = '{"a":1}';
  assert.equal(verifySignature(raw, sign(raw), APP_SECRET), true);
  assert.equal(verifySignature(raw, sign('{"a":2}'), APP_SECRET), false);
  assert.equal(verifySignature(raw, 'sha256=zénon', APP_SECRET), false);
  assert.equal(verifySignature(raw, undefined, APP_SECRET), false);
  assert.equal(toMsid('+33 6 12 34 56 78'), '33612345678');
});

test('e2e : webhook vocal → Whisper → LLM → Notion → Sheets → réponse WhatsApp', async () => {
  const payload = webhookBody(audioMessage(`wamid.A${randomUUID().slice(0, 8)}`));
  const raw = JSON.stringify(payload);
  const { res } = await postWebhook(payload, sign(raw));
  assert.equal(res.status, 200, await res.text());

  const run = await wait(() => store.runs.list({ limit: 1 })[0]);
  assert.equal(run.ruleId, 'voice-to-crm');
  assert.equal(run.status, 'ok', JSON.stringify(run.steps));
  assert.deepEqual(run.steps.map((s) => s.ok), [true, true, true, true, true, true]);

  const names = run.steps.map((s) => s.action);
  assert.deepEqual(names, ['assign_contact', 'transcribe', 'llm_extract', 'notion_create_page', 'sheets_append_row', 'reply']);

  const transcript = run.steps.find((s) => s.action === 'transcribe');
  assert.equal(transcript.detail.output, TRANSCRIPT);

  const extract = run.steps.find((s) => s.action === 'llm_extract');
  assert.equal(extract.detail.output.source, 'llm');
  assert.equal(extract.detail.output.title, 'Devis salle de bain');

  // La date relative (« demain à 14h ») est recalculée localement, pas par le LLM.
  const tomorrow = new Date(Date.now() + 864e5);
  const isoTomorrow = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  assert.equal(extract.detail.output.date, isoTomorrow);
  assert.equal(extract.detail.output.time, '14:00');

  const notion = mock.last('POST', '/notion/v1/pages');
  const properties = notion.json.properties;
  assert.equal(notion.json.parent.database_id, 'db-mock');
  assert.equal(properties.Nom.title[0].text.content, 'Devis salle de bain');
  assert.equal(properties.Catégorie.select.name, 'devis');
  assert.equal(properties['Échéance'].date.start, isoTomorrow);
  assert.equal(properties.Contact.rich_text[0].text.content, 'Awa Diop');
  assert.ok(notion.headers.authorization === 'Bearer mock-notion' && notion.headers['notion-version'] === '2022-06-28');

  const sheets = mock.last('POST', 'Demandes:append');
  assert.equal(sheets.query.valueInputOption, 'USER_ENTERED');
  assert.equal(sheets.headers.authorization, 'Bearer ya29.mock');
  assert.equal(sheets.headers['content-type'], 'application/json');
  assert.deepEqual(sheets.json.values[0], ['Awa Diop', 'Devis salle de bain', isoTomorrow]);

  // L'échange du JWT Google doit passer en formulaire, pas en JSON.
  const tokenCall = mock.last('POST', '/token');
  assert.match(tokenCall.headers['content-type'], /x-www-form-urlencoded/);
  assert.match(tokenCall.body, /grant_type=urn%3Aietf/);

  const sent = mock.last('POST', '/graph/v23.0/111/messages');
  assert.equal(sent.json.to, PHONE);
  assert.match(sent.json.text.body, /^Bien noté Awa ✅ Devis salle de bain, pour /);
  assert.match(sent.json.text.body, new RegExp(`pour ${isoTomorrow} 14:00`));

  const media = mock.last('GET', '/media/blob');
  assert.equal(media.headers.authorization, 'Bearer mock-page-token');

  await wait(() => store.events.list({ where: (e) => e.kind === 'outbound' }).length > 0);
  assert.equal(store.contacts.count(), 1);
});

test('idempotence : le retentage de Meta ne duplique pas les tâches', async () => {
  const message = audioMessage('wamid.DUPLICATE-1');
  const payload = webhookBody(message);
  const first = await engine.handle(cloud.parse(payload).messages[0]);
  assert.equal(first.runs.length, 1);
  const second = await engine.handle(cloud.parse(payload).messages[0]);
  assert.equal(second.duplicate, true);
  assert.equal(second.runs.length, 0);
});

test('cooldown : un second vocal dans la fenêtre ne relance pas la règle exclusive', async () => {
  const before = store.runs.count();
  const msg = cloud.parse(webhookBody(audioMessage('wamid.COOLDOWN-1'))).messages[0];
  await engine.handle(msg);
  const mid = store.runs.list({ limit: 1 })[0];
  assert.ok(['ok', 'cooldown'].includes(mid.status));

  const msg2 = cloud.parse(webhookBody(audioMessage('wamid.COOLDOWN-2'))).messages[0];
  const second = await engine.handle(msg2);
  assert.equal(second.runs[0].status, 'cooldown');
  assert.equal(store.runs.count(), before + 2);
});

test('webhook non signé est rejeté, et le pipeline tourne sans envoyer de SMS en simulation', async () => {
  const payload = webhookBody(textMessage('wamid.SIG-1', 'Bonjour, un devis svp'));
  const bad = await postWebhook(payload, 'sha256=' + '0'.repeat(64));
  assert.equal(bad.res.status, 401);

  const sim = await api('/api/simulate', { method: 'POST', body: JSON.stringify({ text: 'Bonjour, un devis svp', chatId: PHONE }) });
  const data = await sim.json();
  assert.equal(data.runs[0].ruleId, 'quote-to-crm');
  assert.equal(data.runs[0].status, 'ok');
  assert.equal(data.runs[0].steps.at(-1).detail.simulated, true);
  assert.equal(data.outbox.at(-1).chatId, toMsid(PHONE));

  // Rien de nouveau côté Meta : la simulation n'a pas touché le vrai send.
  assert.equal(mock.hits('POST', '/graph/v23.0/111/messages').length, 1);
});

test('explications de règles et journal accessible', async () => {
  const explained = await (await api('/api/explain', { method: 'POST', body: JSON.stringify({ text: 'une question sans mot-clé ?', chatId: PHONE }) })).json();
  assert.deepEqual(explained.matched.map((r) => r.id), ['fallback-ai']);

  const state = await (await api('/api/state')).json();
  assert.equal(state.provider, 'cloud');
  assert.equal(state.connectors.notion.ready, true);
  assert.equal(state.connectors.sheets.ready, true);
  assert.equal(state.rules.enabled, 3);
  assert.ok(state.counts.events > 0);

  const events = await (await api('/api/events?limit=5')).json();
  assert.ok(events.events.length > 0);
  assert.ok(events.events.every((e) => e.ts));
});

test('le tableau de bord exige le jeton admin', async () => {
  const noToken = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(noToken.status, 401);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(html.headers.get('content-type'), /text\/html/);
});

test('rules.json modifié via l’UI est validé puis pris en compte', async () => {
  const document = await (await api('/api/rules')).json();
  const broken = { rules: [{ id: 'x', steps: [{ action: 'action_inexistante' }] }] };
  const rejected = await api('/api/rules', { method: 'PUT', body: JSON.stringify(broken) });
  assert.equal(rejected.status, 422);
  const message = (await rejected.json()).error;
  assert.match(message, /action inconnue/);

  const saved = await api('/api/rules', { method: 'PUT', body: JSON.stringify(document) });
  assert.equal(saved.status, 200);
  const ok = await saved.json();
  assert.equal(ok.enabled, 3);
});

import { loadConfig } from './config.js';
import { logger } from './log.js';
import { openStore } from './store.js';
import { RuleSet } from './rules.js';
import { Engine } from './engine.js';
import { CloudWhatsApp } from './wa/cloud.js';
import { TestWhatsApp } from './wa/test.js';
import { createApp } from './server.js';

const config = loadConfig();
const log = logger('passerelle');
const store = openStore(config.dataDir);
const rules = new RuleSet(config.rulesPath, log.child('rules')).load();

const messenger = config.wa.provider === 'cloud'
  ? new CloudWhatsApp(config, log.child('whatsapp'))
  : new TestWhatsApp(config, log.child('whatsapp'));

const engine = new Engine({ config, rules, store, messenger, log: log.child('moteur') });
const server = createApp({ config, store, rules, engine, messenger, log: log.child('http') });

if (rules.problems.length) log.warn('règles invalides', { problems: rules.problems });
if (!config.adminToken && config.host === '0.0.0.0') {
  log.warn('ADMIN_TOKEN vide sur 0.0.0.0 : le tableau de bord est ouvert au réseau. Mets-en un avant de publier.');
}
if (config.wa.provider === 'cloud' && (!config.wa.accessToken || !config.wa.phoneNumberId)) {
  log.warn('provider=cloud mais WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID manquent');
}
if (config.wa.provider === 'cloud' && !config.wa.appSecret) {
  log.warn('WA_APP_SECRET absent : les webhooks non signés seront acceptés. À configurer en production.');
}

// Édition de rules.json hors du process (nano, VS Code) => prise en compte à chaud.
const watcher = setInterval(() => rules.reloadIfChanged(), 4000);
watcher.unref();

server.listen(config.port, config.host, () => {
  const base = `http://localhost:${config.port}`;
  log.info('Passerelle démarrée', { port: config.port, provider: config.wa.provider, dataDir: config.dataDir, règles: rules.rules.length });
  process.stdout.write(`
  Passerelle — WhatsApp → Notion / Sheets / Airtable
  ──────────────────────────────────────────────────
  Tableau de bord   ${base}/
  Santé             ${base}/health
  Webhook Meta      ${config.publicBaseUrl || base}${'/webhook/whatsapp'}
  Mode WhatsApp     ${config.wa.provider}${config.wa.provider === 'test' ? ' (aucun message réel n\'est envoyé)' : ''}
  Règles actives    ${rules.rules.length} dans ${config.rulesPath}
  ──────────────────────────────────────────────────
  Test express      ${base}/ puis onglet « Simuler », ou:
                    curl -X POST ${base}/api/simulate -d '{"text":"j\'ai besoin d\'un devis demain"}' -H 'content-type: application/json'${config.adminToken ? " -H 'x-passerelle-token: …'" : ''}
\n`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info(`arrêt (${signal})`);
    clearInterval(watcher);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('unhandledRejection', (reason) => log.error('promesse non gérée', { reason: String(reason) }));

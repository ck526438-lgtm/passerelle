import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** Parse un fichier .env minimal (quotes, \n échappé, pas de subshell). */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

function readEnvFile(cwd) {
  for (const name of ['.env', '.env.local']) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) return parseEnv(fs.readFileSync(file, 'utf8'));
  }
  return {};
}

const bool = (v) => v === '1' || v === 'true' || v === 'yes';
const int = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

/** "8-19" -> {start:8,end:19} ; "1-5" ou "1,2,6" -> [1,2,3,4,5] */
function parseRange(spec, min, max) {
  const text = String(spec ?? '').trim();
  if (!text) return null;
  if (text.includes('-') && !text.includes(',')) {
    const [a, b] = text.split('-').map((n) => Number(n.trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const out = [];
    for (let i = a; i <= b; i += 1) if (i >= min && i <= max) out.push(i);
    return out;
  }
  return text.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= min && n <= max);
}

/**
 * Toute la config vient de l'environnement. Les URLs sont surchargeables :
 * c'est ce qui permet de faire tourner le pipeline complet contre un serveur
 * de mock dans les tests.
 */
export function loadConfig({ cwd = ROOT, env = process.env } = {}) {
  const file = readEnvFile(cwd);
  const get = (key, fallback = '') => {
    const value = env[key] ?? file[key] ?? fallback;
    return value === '' ? fallback : value;
  };

  const serviceAccount = get('GOOGLE_SERVICE_ACCOUNT_JSON')
    || (get('GOOGLE_SERVICE_ACCOUNT_PATH')
      ? safeRead(path.resolve(cwd, get('GOOGLE_SERVICE_ACCOUNT_PATH')))
      : '');

  return {
    cwd,
    dataDir: get('DATA_DIR', path.join(cwd, 'data')),
    rulesPath: path.resolve(cwd, get('RULES_FILE', 'rules.json')),
    port: int(get('PORT', '8787'), 8787),
    host: get('HOST', '0.0.0.0'),
    publicBaseUrl: get('PUBLIC_BASE_URL', ''),
    adminToken: get('ADMIN_TOKEN', ''),

    wa: {
      provider: get('WA_PROVIDER', 'test'),
      phoneNumberId: get('WA_PHONE_NUMBER_ID'),
      accessToken: get('WA_ACCESS_TOKEN'),
      appSecret: get('WA_APP_SECRET'),
      verifyToken: get('WA_VERIFY_TOKEN'),
      apiVersion: get('WA_API_VERSION', 'v23.0'),
      graphBaseUrl: get('GRAPH_BASE_URL', 'https://graph.facebook.com'),
      // Numéros que l'on ignore (le nôtre, les tests) pour ne pas s'auto-répondre.
      selfNumbers: get('WA_SELF_NUMBERS').split(',').map((s) => s.trim()).filter(Boolean),
      groupReply: bool(get('REPLY_IN_GROUPS', 'false')),
    },

    llm: {
      apiKey: get('OPENAI_API_KEY'),
      baseUrl: get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: get('LLM_MODEL', 'gpt-4o-mini'),
    },
    whisper: {
      apiKey: get('OPENAI_API_KEY'),
      baseUrl: get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: get('WHISPER_MODEL', 'whisper-1'),
      language: get('WHISPER_LANGUAGE', 'fr'),
      maxMb: int(get('MAX_MEDIA_MB', '16'), 16),
    },
    notion: {
      token: get('NOTION_TOKEN'),
      databaseId: get('NOTION_DATABASE_ID'),
      baseUrl: get('NOTION_BASE_URL', 'https://api.notion.com'),
      version: get('NOTION_VERSION', '2022-06-28'),
    },
    google: {
      serviceAccount,
      sheetId: get('SHEET_ID'),
      tokenUrl: get('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      sheetsBaseUrl: get('SHEETS_BASE_URL', 'https://sheets.googleapis.com'),
    },
    airtable: {
      token: get('AIRTABLE_TOKEN'),
      baseId: get('AIRTABLE_BASE_ID'),
      table: get('AIRTABLE_TABLE', 'Contacts'),
      baseUrl: get('AIRTABLE_BASE_URL', 'https://api.airtable.com'),
    },

    business: {
      hours: parseRange(get('BUSINESS_HOURS', '8-19'), 0, 23) ?? [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
      days: parseRange(get('BUSINESS_DAYS', '1-6'), 0, 6) ?? [1, 2, 3, 4, 5, 6],
      /** Décalage UTC en minutes, pour évaluer l'heure locale du commerce quel que soit l'hôte. */
      utcOffsetMinutes: int(get('UTC_OFFSET_MINUTES', '120'), 120),
    },

    alerts: { webhookUrl: get('ALERT_WEBHOOK_URL') },

    limits: {
      maxMediaBytes: int(get('MAX_MEDIA_MB', '16'), 16) * 1024 * 1024,
      cooldownSeconds: int(get('COOLDOWN_SECONDS', '90'), 90),
      httpTimeoutMs: int(get('HTTP_TIMEOUT_MS', '45000'), 45000),
    },
  };
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Carte des connecteurs branchés, affichée dans le tableau de bord. */
export function capabilities(config) {
  return {
    whatsapp: { key: 'whatsapp', label: 'WhatsApp', provider: config.wa.provider, ready: config.wa.provider === 'test' || Boolean(config.wa.accessToken && config.wa.phoneNumberId) },
    whisper: { key: 'whisper', label: 'Transcription vocale', ready: Boolean(config.whisper.apiKey), detail: config.whisper.model },
    llm: { key: 'llm', label: 'Extraction IA', ready: Boolean(config.llm.apiKey), detail: config.llm.model },
    notion: { key: 'notion', label: 'Notion', ready: Boolean(config.notion.token && config.notion.databaseId) },
    sheets: { key: 'sheets', label: 'Google Sheets', ready: Boolean(config.google.serviceAccount && config.google.sheetId) },
    airtable: { key: 'airtable', label: 'Airtable', ready: Boolean(config.airtable.token && config.airtable.baseId) },
  };
}

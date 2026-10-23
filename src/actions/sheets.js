import { request, postJson } from '../lib/http.js';
import { render, renderDeep } from '../lib/template.js';
import { GoogleTokenSource } from '../lib/google-auth.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const sources = new Map();

function tokenSource(config) {
  if (!config.google.serviceAccount) return null;
  const key = `${config.google.tokenUrl}:${config.google.serviceAccount.length}`;
  if (!sources.has(key)) sources.set(key, new GoogleTokenSource({ serviceAccount: config.google.serviceAccount, tokenUrl: config.google.tokenUrl, scope: SCOPE }));
  return sources.get(key);
}

function sheetUrl(config, sheetId, suffix) {
  return `${config.google.sheetsBaseUrl.replace(/\/+$/, '')}/v4/spreadsheets/${encodeURIComponent(sheetId)}/${suffix}`;
}

export const sheetsActions = {
  sheets_append_row: {
    label: 'Ajouter une ligne Google Sheets',
    description: 'Le CRM le plus simple du monde : une feuille, une ligne par contact ou par demande.',
    async run(step, ctx) {
      const sheetId = render(step.sheet_id ?? '', ctx.scope) || ctx.config.google.sheetId;
      const source = tokenSource(ctx.config);
      if (!source || !sheetId) {
        if (step.required) throw new Error('sheets_append_row: GOOGLE_SERVICE_ACCOUNT_JSON + SHEET_ID requis');
        return { skipped: 'Google Sheets non connecté', output: null };
      }
      const mapping = renderDeep(step.columns ?? {}, ctx.scope);
      const values = step.row ? step.row.map((cell) => String(render(cell, ctx.scope) ?? '')) : Object.values(mapping).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')));
      if (!values.length) throw new Error('sheets_append_row: aucune colonne (`columns` ou `row`)');
      const tab = render(step.tab ?? step.sheet ?? 'Feuil1', ctx.scope);
      // Le nom de feuille seul suffit : Google place la ligne après le dernier tableau.
      const range = encodeURIComponent(tab);
      const token = await source.token();
      const { json } = await postJson(`${sheetUrl(ctx.config, sheetId, `values/${range}:append`)}?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: [values] }, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { output: { updatedRange: json?.updatedRange, rows: json?.updatedRows ?? 1 }, updatedRange: json?.updatedRange };
    },
  },

  sheets_lookup: {
    label: 'Chercher dans Google Sheets',
    description: 'Retrouve une fiche client à partir d\'une colonne. Sortie : un objet `{ colonne: valeur }`.',
    async run(step, ctx) {
      const sheetId = render(step.sheet_id ?? '', ctx.scope) || ctx.config.google.sheetId;
      const source = tokenSource(ctx.config);
      if (!source || !sheetId) {
        if (step.required) throw new Error('sheets_lookup: connexion Google Sheets requise');
        return { skipped: 'Google Sheets non connecté', output: null };
      }
      const tab = render(step.tab ?? 'Feuil1', ctx.scope);
      const token = await source.token();
      const { json } = await request(sheetUrl(ctx.config, sheetId, `values/${encodeURIComponent(tab)}`), { headers: { authorization: `Bearer ${token}` } });
      const rows = json?.values ?? [];
      if (rows.length < 2) return { output: null, found: false, reason: 'feuille vide' };
      const [header, ...body] = rows;
      const needle = String(render(step.where_value ?? '', ctx.scope)).trim().toLowerCase();
      const columnIndex = header.findIndex((h) => String(h).trim().toLowerCase() === String(step.where_column ?? '').trim().toLowerCase());
      if (columnIndex === -1 || !needle) return { output: null, found: false, reason: 'colonne introuvable' };
      const match = body.find((row) => String(row[columnIndex] ?? '').trim().toLowerCase() === needle) ?? body.find((row) => String(row[columnIndex] ?? '').toLowerCase().includes(needle));
      if (!match) return { output: null, found: false, reason: 'aucune correspondance' };
      const output = Object.fromEntries(header.map((h, i) => [String(h || `col${i}`), match[i] ?? '']));
      return { output, found: true };
    },
  },
};

import { postJson, request } from '../lib/http.js';
import { render, renderDeep } from '../lib/template.js';

export const airtableActions = {
  airtable_create_record: {
    label: 'Créer un enregistrement Airtable',
    description: 'Idéal pour un pipeline de leads : une table « Leads », une ligne par demande entrante.',
    async run(step, ctx) {
      const token = step.token ?? ctx.config.airtable.token;
      const baseId = render(step.base ?? ctx.config.airtable.baseId ?? '', ctx.scope);
      const table = encodeURIComponent(render(step.table ?? ctx.config.airtable.table ?? '', ctx.scope));
      if (!token || !baseId || !table) {
        if (step.required) throw new Error('airtable_create_record: AIRTABLE_TOKEN + AIRTABLE_BASE_ID requis');
        return { skipped: 'Airtable non connecté', output: null };
      }
      const fields = renderDeep(step.fields ?? {}, ctx.scope);
      for (const [k, v] of Object.entries(fields)) if (v === '' || v === null || v === undefined) delete fields[k];
      if (!Object.keys(fields).length) throw new Error('airtable_create_record: `fields` vide');
      const { json } = await postJson(`${ctx.config.airtable.baseUrl.replace(/\/+$/, '')}/v0/${baseId}/${table}`, { fields }, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { output: { id: json?.id, fields: json?.fields }, recordId: json?.id };
    },
  },
};

/** Sortie générique : n'importe quel URL (CRM maison, Make, Slack, Slack-like…). */
export const genericActions = {
  http_request: {
    label: 'Requête HTTP sortante',
    description: 'Appelle n\'importe quelle API. La réponse est stockée dans la variable `as`.',
    async run(step, ctx) {
      const url = render(step.url ?? '', ctx.scope);
      if (!/^https?:\/\//.test(url)) throw new Error(`http_request: URL invalide (${url})`);
      const headers = renderDeep(step.headers ?? {}, ctx.scope);
      const body = step.body === undefined ? undefined : (typeof step.body === 'string' ? render(step.body, ctx.scope) : JSON.stringify(renderDeep(step.body, ctx.scope)));
      if (typeof body === 'string' && !headers['content-type'] && step.body) headers['content-type'] = 'application/json';
      const response = await request(url, {
        method: step.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        timeoutMs: step.timeoutMs ?? 20000,
        retries: step.retries ?? 1,
        maxBytes: step.maxBytes ?? 512 * 1024,
      });
      const payload = response.json ?? response.text;
      if (step.fail_on_status !== false && response.status >= 400) throw new Error(`http_request: statut ${response.status}`);
      return { output: payload, status: response.status };
    },
  },

  set: {
    label: 'Définir une variable',
    description: 'Crée une variable réutilisable dans les étapes suivantes (via `{{nom}}`).',
    async run(step, ctx) {
      const output = renderDeep(step.value ?? {}, ctx.scope);
      return { output };
    },
  },
};

import { postJson } from '../lib/http.js';
import { render, renderDeep } from '../lib/template.js';

const clean = (v) => (v === undefined || v === null || v === '' ? null : v);

/** Shorthand des règles -> payload `properties` Notion. */
export function buildProperties(step, scope) {
  const properties = {};
  const title = clean(render(step.title ?? '', scope));
  if (title !== null) {
    properties[step.title_property ?? 'Name'] = { title: [{ text: { content: title } }] };
  }
  const simple = { text: (v) => ({ rich_text: [{ text: { content: String(v) } }] }), select: (v) => ({ select: { name: String(v) } }), status: (v) => ({ status: { name: String(v) } }) };
  for (const [type, builder] of Object.entries(simple)) {
    for (const [name, value] of Object.entries(renderDeep(step[type] ?? {}, scope))) {
      const v = clean(value);
      if (v !== null) properties[name] = builder(v);
    }
  }
  for (const [name, value] of Object.entries(renderDeep(step.date ?? {}, scope))) {
    const v = clean(value);
    if (v === null) continue;
    const time = clean(render(step.date_time?.[name] ?? '', scope));
    properties[name] = { date: { start: String(v), end: clean(render(step.date_end?.[name] ?? '', scope)) || undefined, ...(time ? { date_time: `${v}T${time}:00+02:00` } : {}) } };
  }
  for (const key of ['checkbox', 'number', 'url', 'email', 'phone_number']) {
    for (const [name, value] of Object.entries(renderDeep(step[key] ?? {}, scope))) {
      const v = clean(value);
      if (v === null && key !== 'checkbox') continue;
      properties[name] = { [key]: key === 'number' ? Number(v) : Boolean(v) };
    }
  }
  Object.assign(properties, renderDeep(step.properties ?? {}, scope));
  return properties;
}

export const notionActions = {
  notion_create_page: {
    label: 'Créer une page Notion',
    description: 'Ajoute une ligne/sous-page dans une base de données Notion (ex. votre CRM ou votre file de tâches).',
    async run(step, ctx) {
      const token = step.token ?? ctx.config.notion.token;
      const databaseId = render(step.database_id ?? step.database ?? '', ctx.scope) || ctx.config.notion.databaseId;
      if (!token || !databaseId) {
        if (step.required) throw new Error('notion_create_page: NOTION_TOKEN et NOTION_DATABASE_ID sont requis');
        return { skipped: 'Notion non connecté', output: null };
      }
      const properties = buildProperties(step, ctx.scope);
      const payload = {
        parent: { database_id: databaseId },
        properties,
        ...(step.children_text ? { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: render(step.children_text, ctx.scope) } }] } }] } : {}),
      };
      const { json } = await postJson(`${trimSlash(ctx.config.notion.baseUrl)}/v1/pages`, payload, {
        headers: { authorization: `Bearer ${token}`, 'notion-version': ctx.config.notion.version },
        maxBytes: 1024 * 1024,
      });
      if (!json?.id) throw new Error('notion_create_page: réponse inattendue, sans id');
      ctx.log.info('page Notion créée', { id: json.id, url: json.url });
      return { output: { id: json.id, url: json.url, properties: Object.keys(properties) }, url: json.url, pageId: json.id };
    },
  },

  notion_append_comment: {
    label: 'Commenter une page Notion',
    description: 'Ajoute un commentaire en bas d\'une page existante (id issu d\'une variable de règle).',
    async run(step, ctx) {
      const token = step.token ?? ctx.config.notion.token;
      const pageId = render(step.page_id ?? '', ctx.scope);
      const text = render(step.text ?? '', ctx.scope);
      if (!token || !pageId || !text) {
        if (step.required) throw new Error('notion_append_comment: page_id + texte requis');
        return { skipped: 'Notion non connecté ou page_id vide', output: null };
      }
      await postJson(`${trimSlash(ctx.config.notion.baseUrl)}/v1/comments`, { parent: { page_id: pageId, type: 'page_id' }, rich_text: [{ text: { content: text } }] }, {
        headers: { authorization: `Bearer ${token}`, 'notion-version': ctx.config.notion.version },
      });
      return { output: text };
    },
  },
};

const trimSlash = (u) => String(u).replace(/\/+$/, '');

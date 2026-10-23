/** Chemin type "task.due" ou "a.0.b" dans un objet. */
export function getPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
  return obj;
}

const TOKEN = /\{\{\s*([\w.]+)\s*(?:\?\?\s*(?:"([^"]*)"|([\w.]+)))?\s*\}\}/g;
const BLOCK = /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;

const truthy = (value) => !(value === undefined || value === null || value === '' || value === false
  || (Array.isArray(value) && value.length === 0));

/**
 * Gabarits des règles :
 *   `{{transcript}}`, `{{task.title ?? "Note vocale"}}`
 *   `{{#task.dueLabel}} pour {{task.dueLabel}}{{/task.dueLabel}}` (bloc conditionnel)
 *   `{{^task.date}}sans échéance{{/task.date}}` (bloc inversé)
 * Un token inconnu devient la valeur par défaut, ou une chaîne vide.
 */
export function render(template, scope) {
  if (template == null) return '';
  const withBlocks = String(template).replace(BLOCK, (_m, marker, path, inner) => {
    const keep = marker === '#' ? truthy(getPath(scope, path)) : !truthy(getPath(scope, path));
    return keep ? render(inner, scope) : '';
  });
  return withBlocks.replace(TOKEN, (_m, path, literal, alias) => {
    const fallback = literal ?? (alias ? getPath(scope, alias) : undefined);
    const value = getPath(scope, path);
    if (!truthy(value)) return fallback == null ? '' : String(fallback);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/** Rend toutes les valeurs string d'un objet (mapping de colonnes, properties Notion…). */
export function renderDeep(node, scope) {
  if (typeof node === 'string') return render(node, scope);
  if (Array.isArray(node)) return node.map((item) => renderDeep(item, scope));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = renderDeep(v, scope);
    return out;
  }
  return node;
}

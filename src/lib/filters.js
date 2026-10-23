import { getPath } from './template.js';

/** Compare insensible à la casse et aux accents ("Devis" == "devis", "école" == "ecole"). */
export function norm(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

const has = (haystack, needle) => haystack.includes(norm(needle));

/**
 * Filtres de déclenchement. Déclaratif, donc éditable dans l'UI sans
 * risquer une injection de code.
 */
export function matchesFilters(spec = {}, scope = {}) {
  const text = norm(scope.searchable ?? '');
  if (spec.types?.length && !spec.types.map(norm).includes(norm(scope.type))) return false;
  if (spec.text_contains_any?.length && !spec.text_contains_any.some((n) => has(text, n))) return false;
  if (spec.text_contains_all?.length && !spec.text_contains_all.every((n) => has(text, n))) return false;
  if (spec.text_excludes_any?.length && spec.text_excludes_any.some((n) => has(text, n))) return false;
  if (spec.text_starts_with_any?.length && !spec.text_starts_with_any.some((n) => text.startsWith(norm(n)))) return false;
  if (spec.text_regex && !safeRegex(spec.text_regex).test(scope.searchable ?? '')) return false;
  if (spec.min_chars && (scope.searchable ?? '').length < spec.min_chars) return false;
  if (spec.max_chars && (scope.searchable ?? '').length > spec.max_chars) return false;
  if (spec.from_country && !spec.from_country.some((cc) => (scope.chatId ?? '').startsWith(cc))) return false;
  for (const [path, expected] of Object.entries(spec.fields ?? {})) {
    const actual = norm(getPath(scope, path));
    const options = Array.isArray(expected) ? expected : [expected];
    if (!options.some((option) => norm(option) === actual)) return false;
  }
  return true;
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return /$^/;
  }
}

const OPS = {
  exists: (v) => v !== undefined && v !== null && v !== '',
  is_empty: (v) => v === undefined || v === null || v === '',
  equals: (v, want) => norm(v) === norm(want),
  not_equals: (v, want) => norm(v) !== norm(want),
  contains: (v, want) => has(norm(v), want),
  starts_with: (v, want) => norm(v).startsWith(norm(want)),
  in: (v, want) => (Array.isArray(want) ? want : String(want).split(',')).map(norm).includes(norm(v)),
  gt: (v, want) => Number(v) > Number(want),
  gte: (v, want) => Number(v) >= Number(want),
  lt: (v, want) => Number(v) < Number(want),
  regex: (v, want) => safeRegex(want).test(String(v ?? '')),
};

/** Condition par étape : { path, op, value }. Sans `path`, on teste le texte du message. */
export function checkCondition(condition, scope) {
  if (!condition) return true;
  if (typeof condition === 'object' && !condition.op) return matchesFilters(condition, scope);
  const { path = 'searchable', op = 'exists', value } = condition;
  const fn = OPS[op];
  if (!fn) throw new Error(`opérateur de condition inconnu: ${op}`);
  return fn(getPath(scope, path), value);
}

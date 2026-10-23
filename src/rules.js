import fs from 'node:fs';
import { actions } from './actions/index.js';
import { matchesFilters } from './lib/filters.js';

/**
 * Une règle = un déclencheur, des filtres, puis des étapes séquentielles.
 * Le fichier est rechargé à chaud depuis l'UI, d'où la validation stricte.
 */
export function validateRules(document) {
  const problems = [];
  const rules = Array.isArray(document) ? document : document?.rules;
  if (!Array.isArray(rules)) {
    return { rules: [], problems: ['Le fichier doit contenir { "rules": [ … ] } ou un tableau de règles.'] };
  }
  const seen = new Set();
  rules.forEach((rule, index) => {
    const where = `règle #${index + 1} (${rule?.id ?? rule?.name ?? 'sans id'})`;
    if (!rule?.id) problems.push(`${where}: champ "id" manquant (sert au cooldown et aux journaux)`);
    if (seen.has(rule?.id)) problems.push(`${where}: "id" dupliqué`);
    seen.add(rule?.id);
    if (!Array.isArray(rule?.steps) || rule.steps.length === 0) problems.push(`${where}: au moins une étape requise`);
    (rule?.steps ?? []).forEach((step, stepIndex) => {
      if (!actions[step?.action]) problems.push(`${where}, étape ${stepIndex + 1}: action inconnue « ${step?.action} »`);
    });
    if (rule?.trigger?.type && rule.trigger.type !== 'inbound_message') {
      problems.push(`${where}: trigger « ${rule.trigger.type} » non supporté pour l'instant`);
    }
  });
  return { rules, problems };
}

export class RuleSet {
  constructor(path, log = console) {
    this.path = path;
    this.log = log;
    this.allRules = [];
    this.rules = [];
    this.problems = [];
    this.mtime = 0;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      this.apply(JSON.parse(raw));
    } catch (error) {
      this.problems = [`${this.path} illisible : ${error.message}`];
      this.allRules = [];
      this.rules = [];
    }
    try {
      this.mtime = fs.statSync(this.path).mtimeMs;
    } catch {
      this.mtime = 0;
    }
    return this;
  }

  /** Recharge si le fichier a été modifié hors du process (édition au couteau). */
  reloadIfChanged() {
    try {
      const stat = fs.statSync(this.path);
      if (stat.mtimeMs !== this.mtime) this.load();
    } catch {
      /* fichier disparu : on garde les règles en mémoire */
    }
    return this;
  }

  apply(document) {
    const { rules, problems } = validateRules(document);
    this.problems = problems;
    this.allRules = rules;
    this.rules = rules.filter((rule) => rule.enabled !== false);
    if (problems.length) this.log.warn?.(`${problems.length} problème(s) de règles`, { problems });
    return this;
  }

  /** Écriture depuis l'UI : refuse et n'écrit rien si le document est invalide. */
  save(document) {
    const candidate = { rules: Array.isArray(document) ? document : (document?.rules ?? []) };
    const { rules, problems } = validateRules(candidate);
    if (problems.length) throw new Error(problems.join('\n'));
    fs.writeFileSync(this.path, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    this.apply(candidate);
    this.mtime = fs.statSync(this.path).mtimeMs;
    return this;
  }

  matching(scope) {
    return this.rules.filter((rule) => matchesFilters(rule.filters ?? {}, scope));
  }
}

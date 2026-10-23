import { randomUUID } from 'node:crypto';
import { checkCondition } from './lib/filters.js';
import { setPath } from './lib/template.js';
import { actions } from './actions/index.js';
import { capabilities } from './config.js';

const withTimeout = (promise, ms, label) => {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${ms} ms)`)), ms); }),
  ]);
};

/**
 * Exécute les règles pour un message entrant.
 * Deux garde-fous non négociables côté WhatsApp : l'idempotence (Meta retente
 * les webhooks) et le cooldown par couple règle/contact (sinon une règle
 * « réponse auto » boucle avec elle-même).
 */
export class Engine {
  constructor({ config, rules, store, messenger, log }) {
    this.config = config;
    this.rules = rules;
    this.store = store;
    this.messenger = messenger;
    this.log = log;
    this.lastRunAt = new Map();
    this.flags = Object.fromEntries(Object.entries(capabilities(config)).map(([key, info]) => [key, info.ready]));
  }

  buildScope(msg) {
    const text = String(msg.text ?? '');
    // L'horloge du commerce, pas celle du serveur : un VPS à Francfort ne doit
    // pas faire croire qu'il est 6h du matin à Abidjan.
    const local = new Date(msg.timestamp * 1000 + this.config.business.utcOffsetMinutes * 60000);
    const hour = local.getUTCHours();
    const weekday = local.getUTCDay();
    return {
      id: msg.id,
      chatId: msg.chatId,
      contactName: msg.contactName ?? '',
      firstName: (msg.contactName ?? '').split(/\s+/)[0] ?? '',
      type: msg.type,
      text,
      searchable: text,
      hasMedia: Boolean(msg.media?.token),
      provider: msg.provider,
      timestamp: msg.timestamp,
      date: local.toISOString().slice(0, 10),
      time: `${String(hour).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`,
      datetime: local.toISOString(),
      hour,
      weekday,
      isOutsideHours: !this.config.business.hours.includes(hour) || !this.config.business.days.includes(weekday),
      isNewContact: !this.store.contacts.has(`contact:${msg.chatId}`),
      alertWebhook: this.config.alerts?.webhookUrl ?? '',
      flags: this.flags,
      msg: { ...msg },
    };
  }

  /**
   * @param {object} msg message normalisé
   * @param {{dryRun?: boolean, messenger?: object}} [options] `messenger` permet
   *   de simuler (aucun message réel ne part vers un client) depuis le tableau de bord.
   * @returns {{event: object, runs: object[], skipped?: string, duplicate?: boolean}}
   */
  async handle(msg, { dryRun = false, messenger = null } = {}) {
    const simulated = Boolean(messenger);
    if (!dryRun && !simulated && this.store.events.has(msg.id)) {
      return { event: null, runs: [], duplicate: true };
    }
    const event = this.store.events.append({
      kind: 'inbound',
      messageId: msg.id,
      chatId: msg.chatId,
      contactName: msg.contactName ?? null,
      type: msg.type,
      text: (msg.text ?? '').slice(0, 1500),
      hasMedia: Boolean(msg.media?.token),
      provider: msg.provider,
      dryRun: dryRun || undefined,
      simulated: simulated || undefined,
    });

    if (this.config.wa.selfNumbers.includes(String(msg.chatId))) {
      return { event, runs: [], skipped: 'expéditeur ignoré (propre numéro)' };
    }

    const scope = this.buildScope(msg);
    const matched = this.rules.matching(scope);
    if (!matched.length) return { event, runs: [], skipped: 'aucune règle ne correspond' };

    const runs = [];
    for (const rule of matched) {
      const run = await this.runRule(rule, msg, scope, { dryRun, messenger, simulated });
      runs.push(run);
      // `exclusive: true` évite l'empilement de réponses sur un même message :
      // la première règle qui traite la demande met fin au traitement.
      if (rule.exclusive && run.status !== 'cooldown') break;
    }
    return { event, runs };
  }

  async runRule(rule, msg, scope, { dryRun = false, messenger = null, simulated = false } = {}) {
    const cooldown = rule.cooldown_seconds ?? this.config.limits.cooldownSeconds;
    const key = `${rule.id}:${msg.chatId}`;
    const last = this.lastRunAt.get(key) ?? 0;
    // Une simulation ne consomme pas le cooldown : on doit pouvoir tester la
    // même règle dix fois de suite depuis le tableau de bord.
    if (!dryRun && !simulated && cooldown > 0 && Date.now() - last < cooldown * 1000) {
      const record = { id: randomUUID().slice(0, 8), ruleId: rule.id, ruleName: rule.name ?? rule.id, messageId: msg.id, status: 'cooldown', steps: [], cooldownSeconds: cooldown };
      this.store.runs.append(record);
      return record;
    }
    if (!simulated) {
      this.lastRunAt.set(key, Date.now());
      if (this.lastRunAt.size > 5000) this.lastRunAt.delete(this.lastRunAt.keys().next().value);
    }

    const started = Date.now();
    const steps = [];
    const runLog = this.log.child?.(rule.id) ?? this.log;
    const ctx = { msg, scope, ruleId: rule.id, config: this.config, log: runLog, store: this.store, messenger: messenger ?? this.messenger, now: () => new Date(started) };
    let status = 'ok';
    let error = null;

    for (const [index, step] of (rule.steps ?? []).entries()) {
      const def = actions[step.action];
      const entry = { index, action: step.action, label: def?.label ?? step.action, as: step.as ?? null };
      if (!def) {
        entry.ok = false;
        entry.error = `action inconnue: ${step.action}`;
        status = 'error';
        steps.push(entry);
        break;
      }
      if (dryRun) {
        entry.ok = true;
        entry.preview = true;
        steps.push(entry);
        continue;
      }
      if (step.if && !checkCondition(step.if, scope)) {
        entry.ok = true;
        entry.skipped = 'condition fausse';
        steps.push(entry);
        continue;
      }
      const stepStart = Date.now();
      try {
        const result = await withTimeout(def.run(step, ctx), step.timeout_ms ?? this.config.limits.httpTimeoutMs, `${rule.id}/${step.action}`);
        entry.ok = true;
        entry.ms = Date.now() - stepStart;
        entry.detail = compact(result);
        if (step.as && result?.output !== undefined) setPath(scope, step.as, result.output);
        if (result?.skipped) entry.skipped = result.skipped;
      } catch (thrown) {
        entry.ok = false;
        entry.ms = Date.now() - stepStart;
        entry.error = thrown?.message ?? String(thrown);
        if (thrown instanceof Error && thrown.status) entry.httpStatus = thrown.status;
        steps.push(entry);
        if (step.continue_on_error) {
          this.log.warn('étape en erreur, on continue', { step: step.action, error: entry.error });
          status = 'partial';
          continue;
        }
        status = 'error';
        error = entry.error;
        break;
      }
      steps.push(entry);
    }

    const record = {
      id: randomUUID().slice(0, 8),
      ruleId: rule.id,
      ruleName: rule.name ?? rule.id,
      messageId: msg.id,
      chatId: msg.chatId,
      status,
      error,
      steps,
      durationMs: Date.now() - started,
      simulated: simulated || undefined,
      vars: pick(scope, rule.expose_vars ?? []),
    };
    this.store.runs.append(record);
    this.log.info(`règle ${rule.id} -> ${status}`, { ms: record.durationMs, error: error ?? undefined });
    return record;
  }

  /** Ce que la règle *ferait* sur ce message, sans exécuter les appels réseau. */
  explain(msg) {
    const scope = this.buildScope(msg);
    return this.rules.matching(scope).map((rule) => ({
      id: rule.id,
      name: rule.name ?? rule.id,
      cooldownSeconds: rule.cooldown_seconds ?? this.config.limits.cooldownSeconds,
      steps: (rule.steps ?? []).map((step) => ({
        action: step.action,
        label: actions[step.action]?.label ?? step.action,
        wouldSkip: Boolean(step.if && !checkCondition(step.if, scope)),
        condition: step.if ?? null,
      })),
    }));
  }
}

const MAX_DETAIL = 900;

function compact(result) {
  if (!result || typeof result !== 'object') return result;
  const { output, ...rest } = result;
  const text = JSON.stringify({ output, ...rest });
  if (text.length <= MAX_DETAIL) return { output, ...rest };
  return { ...rest, output: `${String(JSON.stringify(output)).slice(0, 400)}…`, truncated: true };
}

function pick(scope, keys) {
  const out = {};
  for (const key of keys) out[key] = scope[key];
  return out;
}

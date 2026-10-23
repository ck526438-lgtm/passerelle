#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { logger } from '../src/log.js';
import { openStore } from '../src/store.js';
import { RuleSet } from '../src/rules.js';
import { Engine } from '../src/engine.js';
import { TestWhatsApp } from '../src/wa/test.js';

const HELP = `Usage : node scripts/simulate.js [options] "texte du message"

  --voice            simule une note vocale (le texte est ignoré)
  --from=33612345678 numéro du contact
  --name="Awa Diop"  nom affiché dans WhatsApp
  --explain          liste seulement les règles qui partent
  --dry              n'exécute aucun appel réseau
`;

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, ...rest] = a.slice(2).split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const text = args.find((a) => !a.startsWith('--')) ?? '';

if (!text && !flags.voice) {
  process.stdout.write(HELP);
  process.exit(0);
}

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, amber: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

const config = loadConfig();
const log = logger('simuler');
const store = openStore(config.dataDir);
const rules = new RuleSet(config.rulesPath, log).load();
const messenger = new TestWhatsApp(config, log);
const engine = new Engine({ config, rules, store, messenger, log });

const msg = TestWhatsApp.inbound({
  text,
  type: flags.voice ? 'audio' : 'text',
  chatId: flags.from ?? '33600000000',
  contactName: flags.name ?? 'Client Test',
  mediaToken: flags.voice ? 'simulated-media' : undefined,
});

if (flags.explain) {
  const matched = engine.explain(msg);
  process.stdout.write(`\n${C.bold(msg.type === 'audio' ? '🎤 note vocale' : msg.text)}\n\n`);
  if (!matched.length) process.stdout.write(`${C.amber('Aucune règle ne se déclenche.')}\n\n`);
  for (const rule of matched) {
    process.stdout.write(`${C.green('▶')} ${C.bold(rule.name)} ${C.dim(`(cooldown ${rule.cooldownSeconds}s)`)}\n`);
    rule.steps.forEach((step, i) => process.stdout.write(`   ${i + 1}. ${step.label} ${step.wouldSkip ? C.amber('[étape ignorée]') : ''}\n`));
  }
  process.stdout.write('\n');
  process.exit(0);
}

const result = await engine.handle(msg, { dryRun: Boolean(flags.dry) });
process.stdout.write(`\n${C.dim('entrant')} ${C.bold(msg.type === 'audio' ? '🎤 note vocale (simulée)' : msg.text)} ${C.dim(`de ${msg.contactName} <${msg.chatId}>`)}\n\n`);
if (result.skipped) process.stdout.write(`${C.amber(`— ${result.skipped}`)}\n\n`);
if (result.duplicate) process.stdout.write(`${C.amber('— message déjà traité (idempotence), rien ne sera refait')}\n\n`);

for (const run of result.runs) {
  const icon = run.status === 'ok' ? C.green('✔') : run.status === 'error' ? C.red('✖') : C.amber('●');
  process.stdout.write(`${icon} ${C.bold(run.ruleName)} ${C.dim(`${run.status} · ${run.durationMs} ms`)}\n`);
  for (const step of run.steps) {
    const mark = step.ok ? (step.skipped ? C.amber('~') : C.green('·')) : C.red('×');
    const why = step.ok ? short(step.detail, step.skipped) : C.red(step.error ?? '');
    process.stdout.write(`   ${mark} ${step.label}${step.as ? C.dim(` → \${${step.as}}`) : ''} ${why}\n`);
  }
  process.stdout.write('\n');
}

for (const out of messenger.outbox.slice(-4)) {
  process.stdout.write(`${C.dim('réponse produite →')} ${C.green(out.text)}\n`);
}
process.stdout.write(`\n${C.dim(`journaux : ${config.dataDir} · tableau de bord : http://localhost:${config.port}/`)}\n\n`);

function short(detail, skipped) {
  const output = detail?.output === undefined || detail.output === null ? '' : `sortie ${JSON.stringify(detail.output).slice(0, 140)}`;
  return [output, skipped ? `(${skipped})` : ''].filter(Boolean).join(' ');
}

store.close();

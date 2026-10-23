#!/usr/bin/env node
/**
 * Peuple le journal avec quatre cas métier réalistes, pour une démo ou une
 * capture d'écran. Passe par /api/simulate : rien n'est envoyé à un vrai client.
 */
const base = process.env.DEMO_URL ?? 'http://127.0.0.1:8787';
const token = process.env.ADMIN_TOKEN ?? '';

const cases = [
  { text: 'Bonjour, je voudrais un devis pour refaire la salle de bain, vous pouvez passer demain à 14h ?', chatId: '22890000000', contactName: 'Koffi Adjovi' },
  { type: 'audio', mediaToken: 'simulated-media', chatId: '221770000000', contactName: 'Awa Diop' },
  { text: "J'ai une fuite sous l'évier, c'est urgent !", chatId: '33612345678', contactName: 'Marc Lefèvre' },
  { text: 'Vous êtes ouverts samedi ?', chatId: '22555000000', contactName: 'Fatou Ndiaye' },
];

for (const payload of cases) {
  const res = await fetch(`${base}/api/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-passerelle-token': token },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    process.stderr.write(`${(await res.text())}\n\nLe serveur tourne ?  node src/index.js\n`);
    process.exit(1);
  }
  const data = await res.json();
  const label = payload.type === 'audio' ? '🎤 note vocale' : payload.text;
  process.stdout.write(`\n${payload.contactName} : ${label}\n`);
  for (const run of data.runs) process.stdout.write(`  ${run.status === 'ok' ? '✔' : '✖'} ${run.ruleName} (${run.status})\n`);
  if (!data.runs.length) process.stdout.write(`  — ${data.skipped ?? 'aucune règle déclenchée'}\n`);
  for (const text of data.replies ?? []) process.stdout.write(`  ↳ ${text}\n`);
}
process.stdout.write(`\nTableau de bord : ${base}/\n`);

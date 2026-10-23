#!/usr/bin/env node
/**
 * Captures les images fixes du README dans docs/.
 *
 *   node src/index.js &            # le serveur doit répondre
 *   node scripts/make-shots.cjs
 *
 * Aucune dépendance : Chrome headless écrit directement les PNG. Les paramètres
 * d'URL du tableau de bord (?chars=, ?auto=1, #log…) pilotent la scène, donc
 * chaque capture montre l'interface réelle, jamais une maquette.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:8787';
const DOCS = path.join(__dirname, '..', 'docs');
const DEMO = 'name=Koffi%20Adjovi&phone=22997000000';

const SHOTS = [
  { name: 'capture-simuler', query: DEMO, width: 1440, height: 760 },
  { name: 'capture-pipeline', query: `${DEMO}&auto=1`, width: 1440, height: 1240, budget: 7000 },
  { name: 'capture-journal', query: 'auto=1', hash: 'log', width: 1440, height: 760, budget: 7000 },
  { name: 'capture-regles', hash: 'rules', width: 1440, height: 900 },
  { name: 'capture-connecteurs', hash: 'conn', width: 1440, height: 760 },
];

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('Chrome introuvable : définissez CHROME_PATH');
}

function capture(shot) {
  const target = path.join(DOCS, `${shot.name}.png`);
  const url = `${BASE}/?${shot.query ?? 'x=1'}${shot.hash ? `#${shot.hash}` : ''}`;
  const result = spawnSync(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--disable-extensions',
    `--window-size=${shot.width},${shot.height}`,
    `--virtual-time-budget=${shot.budget ?? 4000}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'passerelle-shot')}`,
    `--screenshot=${target}`,
    url,
  ], { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(target)) {
    throw new Error(`${shot.name}: ${result.stderr || result.stdout || 'aucun fichier'}`);
  }
  return target;
}

function main() {
  const health = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(`${BASE}/health`)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
  if (health.status !== 0) throw new Error(`aucun serveur sur ${BASE} — lancez "node src/index.js"`);

  for (const shot of SHOTS) {
    const target = capture(shot);
    const bytes = fs.statSync(target).size;
    process.stdout.write(`${shot.name}.png  ${shot.width}x${shot.height}  ${(bytes / 1024).toFixed(0)} Ko\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

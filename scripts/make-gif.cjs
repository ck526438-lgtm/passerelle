#!/usr/bin/env node
/**
 * Fabrique docs/demo.gif à partir de l'interface réelle, image par image.
 * Dépendances hors dépôt (le projet reste sans dépendance runtime) :
 *
 *   npm i --no-save pngjs gif-encoder-2
 *   node src/index.js &            # le serveur doit répondre
 *   node scripts/make-gif.cjs
 *
 * Chaque image est capturée par Chrome headless via les paramètres d'URL du
 * tableau de bord (?chars=, ?auto=1) : ce que montre le GIF est exactement ce
 * que voit l'utilisateur, rien n'est redessiné à la main.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PNG = require('pngjs').PNG;
const GifEncoder = require('gif-encoder-2');

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:8787';
const SIZE = { width: Number(process.env.GIF_WIDTH ?? 1180), height: Number(process.env.GIF_HEIGHT ?? 980) };
const FRAMES_DIR = path.join(__dirname, '..', 'docs', 'frames');
const OUT = path.join(__dirname, '..', 'docs', 'demo.gif');

const DEMO_TEXT = "Bonjour, je voudrais un devis pour refaire la salle de bain, vous pouvez passer demain à 14h ?";
const DEMO = 'name=Koffi%20Adjovi&phone=22997000000';

// Une seule et même scène : le GIF reste sur l'onglet Simuler, du champ vide à
// la réponse produite. Les autres onglets sont montrés en captures fixes
// (scripts/make-shots.cjs) pour ne pas alourdir l'animation.
const FRAMES = [
  { name: '01-champ-vide', url: `${BASE}/?${DEMO}&chars=0`, delay: 600 },
  { name: '02-frappe-1', url: `${BASE}/?${DEMO}&chars=22`, delay: 200 },
  { name: '03-frappe-2', url: `${BASE}/?${DEMO}&chars=48`, delay: 200 },
  { name: '04-frappe-3', url: `${BASE}/?${DEMO}&chars=72`, delay: 200 },
  { name: '05-texte-complet', url: `${BASE}/?${DEMO}&chars=${DEMO_TEXT.length}`, delay: 1000 },
  { name: '06-pipeline', url: `${BASE}/?${DEMO}&auto=1`, delay: 3400, budget: 7000 },
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

function capture(frame) {
  const target = path.join(FRAMES_DIR, `${frame.name}.png`);
  const result = spawnSync(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--disable-extensions',
    `--window-size=${SIZE.width},${SIZE.height}`,
    `--virtual-time-budget=${frame.budget ?? 2500}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'passerelle-shot')}`,
    `--screenshot=${target}`,
    frame.url,
  ], { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(target)) {
    throw new Error(`capture ratée (${frame.name}): ${result.stderr || result.stdout || 'aucun fichier'}`);
  }
  return target;
}

function encode(frames) {
  const images = frames.map((frame) => PNG.sync.read(fs.readFileSync(frame.file)));
  const [{ width, height }] = images;
  for (const image of images) {
    if (image.width !== width || image.height !== height) throw new Error('toutes les images doivent avoir la même taille');
  }
  const encoder = new GifEncoder(width, height, 'neuquant', false, images.length);
  encoder.setRepeat(0);
  encoder.setQuality(6);
  encoder.start();
  for (const [index, image] of images.entries()) {
    encoder.setDelay(frames[index].delay);
    encoder.addFrame(Buffer.from(image.data));
  }
  encoder.finish();
  fs.writeFileSync(OUT, Buffer.from(encoder.out.getData()));
  return { width, height };
}

/** Vérifie que le délai écrit dans le GIF correspond bien aux millisecondes voulues. */
function verifyDelays(gifPath, expected) {
  const buffer = fs.readFileSync(gifPath);
  const delays = [];
  for (let i = 0; i < buffer.length - 5; i += 1) {
    if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9 && buffer[i + 2] === 4) {
      delays.push(buffer.readUInt16LE(i + 4) * 10);
      i += 5;
    }
  }
  const drift = delays.map((delay, index) => Math.abs(delay - expected[index])).some((delta) => delta > 20);
  return { delays, drift };
}

function main() {
  const health = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(BASE + '/health')}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], { shell: false });
  if (health.status !== 0) throw new Error(`aucun serveur sur ${BASE} — lancez "node src/index.js"`);

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  for (const entry of fs.readdirSync(FRAMES_DIR)) fs.rmSync(path.join(FRAMES_DIR, entry));

  const started = Date.now();
  for (const frame of FRAMES) {
    frame.file = capture(frame);
    process.stdout.write(`· ${frame.name}\n`);
  }
  const { width, height } = encode(FRAMES);
  const { delays, drift } = verifyDelays(OUT, FRAMES.map((f) => f.delay));
  const size = fs.statSync(OUT).size;
  const total = delays.reduce((a, b) => a + b, 0) / 1000;

  process.stdout.write(`\ndocs/demo.gif  ${width}x${height}  ${FRAMES.length} images  ${total.toFixed(1)} s  ${(size / 1024 / 1024).toFixed(2)} Mo\n`);
  if (drift) process.stdout.write(`⚠ délais GIF != demandés : ${delays.join(', ')}\n`);
  if (size > 8 * 1024 * 1024) process.stdout.write('⚠ plus de 8 Mo : GitHub acceptera mais charge lentement, réduisez GIF_WIDTH.\n');
  process.stdout.write(`(${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

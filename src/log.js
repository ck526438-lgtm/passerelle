const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const REDACT = /(token|secret|key|authorization|password)\b.*$/i;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function fmt(level, scope, message, extra) {
  const base = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (!extra) return base;
  const safe = {};
  for (const [k, v] of Object.entries(extra)) safe[k] = REDACT.test(k) ? '***' : v;
  return `${base} ${JSON.stringify(safe, jsonReplacer)}`;
}

function jsonReplacer(key, value) {
  if (/token|secret|authorization|password/i.test(key)) return '***';
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}b>`;
  return value;
}

export function logger(scope) {
  const emit = (level) => (message, extra) => {
    if (LEVELS[level] < threshold) return;
    const line = fmt(level, scope, message, extra);
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}

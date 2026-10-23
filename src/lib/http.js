export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + timeout + lecture bornée + 2 retries sur les erreurs transitoires.
 * `retryAfter` est respecté (WhatsApp et Notion envoient des 429 avec un delay).
 */
export async function request(url, { method = 'GET', headers, body, timeoutMs = 45000, maxBytes = 25 * 1024 * 1024, retries = 2, expect = 'auto' } = {}) {
  const normalized = normalizeBody(body, headers);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await attemptFetch(url, { method, ...normalized, timeoutMs, maxBytes, expect });
    } catch (error) {
      lastError = error;
      const status = error instanceof HttpError ? error.status : 0;
      if (attempt >= retries || (!RETRYABLE.has(status) && !(status === 0))) break;
      const wait = Number(error.headers?.get?.('retry-after')) * 1000 || 400 * 2 ** attempt;
      await sleep(Math.min(wait, 8000));
    }
  }
  throw lastError;
}

/**
 * Un corps d'objet == du JSON : sans cette étape, fetch stringuify un objet en
 * "[object Object]" et l'API distante renvoie une erreur illisible.
 */
function normalizeBody(body, headers) {
  const out = { ...headers };
  if (body === undefined || body === null) return { headers: out, body: undefined };
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return { headers: out, body };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { headers: out, body };
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return { headers: out, body };
  if (!Object.hasOwn(out, 'content-type') && !Object.hasOwn(out, 'Content-Type')) out['content-type'] = 'application/json';
  return { headers: out, body: JSON.stringify(body) };
}

async function attemptFetch(url, { method, headers, body, timeoutMs, maxBytes, expect }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { method, headers, body, signal });
  const buffer = await readCapped(response, maxBytes);
  const contentType = response.headers.get('content-type') ?? '';
  const text = buffer.toString('utf8');

  if (!response.ok) {
    const error = new HttpError(`${method} ${url} -> ${response.status} ${truncate(text)}`, {
      status: response.status,
      url,
      body: tryJson(text) ?? text,
    });
    error.headers = response.headers;
    throw error;
  }
  if (expect === 'json' || (expect === 'auto' && contentType.includes('json'))) {
    const parsed = tryJson(text);
    if (parsed === undefined && text.trim()) throw new HttpError(`${method} ${url} -> JSON invalide: ${truncate(text)}`, { status: response.status, url });
    return { status: response.status, headers: response.headers, json: parsed, text, buffer };
  }
  return { status: response.status, headers: response.headers, json: undefined, text, buffer };
}

async function readCapped(response, maxBytes) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(`Réponse trop volumineuse (> ${Math.round(maxBytes / 1024 / 1024)} Mo)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

const truncate = (s) => (s.length > 400 ? `${s.slice(0, 400)}…` : s);

export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function postJson(url, payload, options = {}) {
  return request(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: payload,
  });
}

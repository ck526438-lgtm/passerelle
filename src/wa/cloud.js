import { createHmac, timingSafeEqual } from 'node:crypto';
import { request, postJson } from '../lib/http.js';
import { sniffMime } from '../lib/audio.js';

/** WhatsApp n'accepte que des numéros en format local sans `+` ni `0` de prefixe. */
export function toMsid(chatId) {
  return String(chatId ?? '').replace(/[^\d]/g, '').replace(/^0+/, '');
}

/** Signature du webhook : `sha256=<hmac(rawBody, appSecret)>`. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  const provided = String(header ?? '').replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

/**
 * Message entrant normalisé, identique quelle que soit la source
 * (Cloud API, Baileys plus tard, ou l'injecteur de l'UI).
 *
 * @typedef {Object} InboundMessage
 * @property {string} id            identifiant fournisseur (idempotence)
 * @property {string} chatId        numéro expéditeur (E.164 sans +)
 * @property {string} [contactName]
 * @property {'text'|'audio'|'image'|'document'|'interactive'|'unknown'} type
 * @property {string} [text]
 * @property {{token: string, mime: string}} [media]
 * @property {number} timestamp
 * @property {string} provider
 */
export class CloudWhatsApp {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.provider = 'cloud';
  }

  get base() {
    return `${this.config.wa.graphBaseUrl}/${this.config.wa.apiVersion}`;
  }

  get authHeaders() {
    return { authorization: `Bearer ${this.config.wa.accessToken}` };
  }

  /** Poignée de main Meta : GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… */
  challengeFor(query) {
    if (query.get('hub.mode') !== 'subscribe') return null;
    const token = query.get('hub.verify_token');
    if (!this.config.wa.verifyToken || token !== this.config.wa.verifyToken) {
      this.log.warn('verify_token refusé', { received: token });
      return null;
    }
    return query.get('hub.challenge');
  }

  /** Corps du webhook -> { messages, statuses }. Ne lève jamais : un webhook WhatsApp doit retourner 200. */
  parse(payload) {
    const messages = [];
    const statuses = [];
    for (const entry of toArray(payload?.entry)) {
      for (const change of toArray(entry?.changes)) {
        const value = change?.value;
        if (!value) continue;
        const names = new Map(toArray(value.contacts).map((c) => [c.wa_id, c.profile?.name]));
        for (const raw of toArray(value.messages)) {
          const parsed = normalizeMessage(raw, { names, provider: this.provider });
          if (parsed) messages.push(parsed);
        }
        for (const st of toArray(value.statuses)) statuses.push(st);
      }
    }
    return { messages, statuses };
  }

  /** Les media WhatsApp sont à deux temps : on récupère une URL temporaire, puis les octets. */
  async downloadMedia(mediaId, maxBytes) {
    const { json: meta } = await request(`${this.base}/${mediaId}`, { headers: this.authHeaders, maxBytes: 64 * 1024 });
    if (!meta?.url) throw new Error(`Média ${mediaId} introuvable côté Meta`);
    const { buffer } = await request(meta.url, { headers: this.authHeaders, maxBytes });
    return { buffer, mime: meta.mime_type || sniffMime(buffer) };
  }

  async sendText(chatId, text, { replyTo } = {}) {
    const msisdn = toMsid(chatId);
    const body = {
      messaging_product: 'whatsapp',
      to: msisdn,
      type: 'text',
      text: { body: text, preview_url: false },
    };
    if (replyTo) body.context = { message_id: replyTo };
    const { json } = await postJson(`${this.base}/${this.config.wa.phoneNumberId}/messages`, body, {
      headers: this.authHeaders,
      maxBytes: 256 * 1024,
    });
    const id = json?.messages?.[0]?.id ?? null;
    this.log.info('message envoyé', { to: msisdn, id, chars: text.length });
    return { id, raw: json };
  }

  async markAsRead(messageId) {
    await postJson(`${this.base}/${this.config.wa.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, { headers: this.authHeaders, retries: 0 }).catch((error) => this.log.debug('accusé de lecture raté', { error: String(error) }));
  }
}

function normalizeMessage(raw, { names, provider }) {
  if (!raw?.id || !raw.from) return null;
  const base = {
    id: raw.id,
    chatId: toMsid(raw.from),
    contactName: names.get(toMsid(raw.from)) ?? raw.name ?? undefined,
    timestamp: Number(raw.timestamp) || Math.floor(Date.now() / 1000),
    provider,
  };
  switch (raw.type) {
    case 'text':
      return { ...base, type: 'text', text: raw.text?.body ?? '', inReplyTo: raw.context?.id };
    case 'audio':
    case 'voice':
      return { ...base, type: 'audio', media: { token: raw.audio?.id, mime: raw.audio?.mime_type ?? 'audio/ogg' } };
    case 'image':
      return { ...base, type: 'image', text: raw.image?.caption ?? '', media: { token: raw.image?.id, mime: raw.image?.mime_type ?? 'image/jpeg' } };
    case 'document':
      return { ...base, type: 'document', text: raw.document?.caption ?? raw.document?.filename ?? '', media: { token: raw.document?.id, mime: raw.document?.mime_type ?? 'application/octet-stream' } };
    case 'video':
      return { ...base, type: 'video', text: raw.video?.caption ?? '', media: { token: raw.video?.id, mime: raw.video?.mime_type ?? 'video/mp4' } };
    case 'button':
      return { ...base, type: 'interactive', text: raw.button?.text ?? '' };
    case 'interactive':
      return { ...base, type: 'interactive', text: raw.interactive?.button_reply?.title ?? raw.interactive?.list_reply?.title ?? '' };
    case 'reaction':
      return { ...base, type: 'reaction', text: raw.emoji ?? '' };
    case 'location':
      return { ...base, type: 'text', text: `localisation ${raw.location?.latitude},${raw.location?.longitude}` };
    default:
      return { ...base, type: 'unknown', text: '' };
  }
}

const toArray = (v) => (Array.isArray(v) ? v : []);

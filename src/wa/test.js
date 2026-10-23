import { randomUUID } from 'node:crypto';
import { fakeVoiceSeconds } from '../lib/audio.js';
import { toMsid } from './cloud.js';

/**
 * Adaptateur de développement : il simule un numéro WhatsApp sans rien
 * connecter. C'est lui qui permet de tester toute la chaîne (transcription
 * incluse) sans credentials, donc sans jamais toucher un vrai client.
 */
export class TestWhatsApp {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.provider = 'test';
    this.outbox = [];
  }

  async sendText(chatId, text, { replyTo } = {}) {
    const record = { id: `test-${randomUUID().slice(0, 8)}`, chatId: toMsid(chatId), text, replyTo, ts: new Date().toISOString() };
    this.outbox.push(record);
    if (this.outbox.length > 50) this.outbox.shift();
    this.log.info('réponse simulée', { to: record.chatId, chars: text.length });
    return { id: record.id, simulated: true };
  }

  /** "Télécharge" un media : une vraie petite forme d'onde WAV, donc le chemin binaire est testé. */
  async downloadMedia(token) {
    if (String(token).startsWith('missing')) throw new Error('média inexistant (test)');
    return { buffer: fakeVoiceSeconds(1.2), mime: 'audio/wav' };
  }

  async markAsRead() {}

  /** Fabrique un message entrant normalisé pour l'injecteur de l'UI et les tests. */
  static inbound({ text = '', type = 'text', chatId = '33600000000', contactName = 'Client Test', mediaToken, provider = 'test', id } = {}) {
    return {
      id: id ?? `wamid.TEST${randomUUID().slice(0, 10).toUpperCase()}`,
      chatId: toMsid(chatId),
      contactName,
      type,
      text,
      media: mediaToken ? { token: mediaToken, mime: 'audio/wav' } : undefined,
      timestamp: Math.floor(Date.now() / 1000),
      provider,
    };
  }
}

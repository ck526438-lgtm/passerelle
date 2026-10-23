import { request } from '../lib/http.js';
import { sniffMime, humanSize } from '../lib/audio.js';

/** Note vocale -> texte via une API compatible Whisper (OpenAI, Groq, local). */
export const mediaActions = {
  transcribe: {
    label: 'Transcrire la note vocale',
    description: 'Télécharge le média WhatsApp et l\'envoie à Whisper. Sortie : une variable texte.',
    async run(step, ctx) {
      const { msg, config, log } = ctx;
      if (!msg.media?.token) {
        if (step.optional) return { skipped: 'pas de média', output: '' };
        throw new Error('transcribe: ce message n\'a pas de média à télécharger');
      }      const { buffer, mime } = await ctx.messenger.downloadMedia(msg.media.token, config.limits.maxMediaBytes);
      const realMime = mime || sniffMime(buffer);
      log.debug('média téléchargé', { bytes: buffer.length, mime: realMime });

      if (!config.whisper.apiKey) {
        if (msg.provider === 'test') {
          const canned = process.env.TEST_TRANSCRIPT ?? 'Bonjour, je voudrais un devis pour refaire la salle de bain, idéalement la semaine prochaine.';
          log.warn('transcription simulée (OPENAI_API_KEY absent)');
          return { output: canned, simulated: true, bytes: buffer.length };
        }
        throw new Error('transcribe: OPENAI_API_KEY manquant, impossible de transcrire');
      }

      const form = new FormData();
      form.append('model', step.model ?? config.whisper.model);
      form.append('language', step.language ?? config.whisper.language);
      form.append('prompt', step.prompt ?? '');
      form.append('response_format', 'json');
      form.append('file', new Blob([new Uint8Array(buffer)], { type: realMime }), filenameFor(realMime));

      const { json } = await request(`${trimSlash(config.whisper.baseUrl)}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.whisper.apiKey}` },
        body: form,
        timeoutMs: step.timeoutMs ?? 60000,
        maxBytes: 2 * 1024 * 1024,
      });
      const text = String(json?.text ?? '').trim();
      if (!text) throw new Error('transcription vide (audio muet ou trop court ?)');
      return { output: text, language: json?.language, seconds: json?.duration, size: humanSize(buffer.length) };
    },
  },
};

const filenameFor = (mime) => ({ 'audio/ogg': 'voice.ogg', 'audio/mpeg': 'voice.mp3', 'audio/mp4': 'voice.m4a', 'audio/wav': 'voice.wav' }[mime] ?? 'voice.bin');
const trimSlash = (u) => String(u).replace(/\/+$/, '');

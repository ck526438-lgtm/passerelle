/** Détection par signature binaire : les webhook WhatsApp mentent parfois sur le mime. */
export function sniffMime(buffer) {
  if (!buffer?.length) return 'application/octet-stream';
  const head = buffer.subarray(0, 12);
  const magic = head.toString('latin1');
  if (magic.startsWith('OggS')) return 'audio/ogg';
  if (magic.startsWith('RIFF') && buffer.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (magic.startsWith('ID3')) return 'audio/mpeg';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (magic.slice(4, 8) === 'ftyp') return 'audio/mp4';
  if (magic.startsWith('%PDF')) return 'application/pdf';
  if (magic.startsWith('\x89PNG')) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * WAV 16-bit mono minimal. Sert aux tests (une fausse note vocale) et permet de
 * vérifier le pipeline transcription sans dépendre d'un vrai media WhatsApp.
 */
export function buildWav(samples, { sampleRate = 16000 } = {}) {
  const frames = samples.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frames * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(frames * 2, 40);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  return Buffer.concat([header, data]);
}

/** Sinusoïde amortie : un "bruit" plausible pour les fixtures. */
export function fakeVoiceSeconds(seconds, { sampleRate = 16000, freq = 220 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    out[i] = 0.25 * Math.sin(2 * Math.PI * freq * t) * Math.exp(-0.35 * t);
  }
  return buildWav(out, { sampleRate });
}

export const humanSize = (bytes) => `${(bytes / 1024).toFixed(0)} Ko`;

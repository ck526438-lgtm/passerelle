import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';

/**
 * Journal append-only en NDJSON. Pas de base à installer, lisible avec un
 * éditeur de texte, et ça suffit largement pour le volume d'une PME.
 * Quand le fichier dépasse `maxBytes`, on le déplace en `.1` (un seul backup).
 */
export class NdjsonLog {
  constructor(file, { cap = 3000, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.file = file;
    this.cap = cap;
    this.maxBytes = maxBytes;
    this.records = [];
    this.byId = new Set();
    this.idQueue = [];
    this.maxIds = 50000;
    this.stream = null;
    this.bytes = 0;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // ligne tronquée par un crash : on l'ignore
        }
        this.#push(record);
      }
      this.bytes = fs.statSync(this.file).size;
    }
    this.stream = createWriteStream(this.file, { flags: 'a' });
    return this;
  }

  #push(record) {
    this.records.push(record);
    for (const id of [record.id, record.messageId]) {
      if (!id) continue;
      if (this.byId.has(id)) continue;
      this.byId.add(id);
      this.idQueue.push(id);
    }
    if (this.records.length > this.cap) this.records.splice(0, this.records.length - this.cap);
    while (this.idQueue.length > this.maxIds) this.byId.delete(this.idQueue.shift());
  }

  has(id) {
    return this.byId.has(id);
  }

  append(record) {
    const full = { ts: new Date().toISOString(), ...record };
    this.#push(full);
    const line = `${JSON.stringify(full)}\n`;
    this.stream.write(line);
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.maxBytes) this.#rotate();
    return full;
  }

  #rotate() {
    this.stream.end();
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      try {
        fs.rmSync(this.file, { force: true });
      } catch {
        /* windows : fichier encore verrouillé, on repassera */
      }
    }
    this.bytes = 0;
    this.stream = createWriteStream(this.file, { flags: 'a' });
  }

  list({ limit = 100, where } = {}) {
    const rows = where ? this.records.filter(where) : this.records;
    return rows.slice(-limit).reverse();
  }

  count(where) {
    return where ? this.records.filter(where).length : this.records.length;
  }

  close() {
    this.stream?.end();
  }
}

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    events: new NdjsonLog(path.join(dataDir, 'events.ndjson')).open(),
    runs: new NdjsonLog(path.join(dataDir, 'runs.ndjson'), { cap: 1500 }).open(),
    contacts: new NdjsonLog(path.join(dataDir, 'contacts.ndjson'), { cap: 5000 }).open(),
    dataDir,
    close() {
      this.events.close();
      this.runs.close();
      this.contacts.close();
    },
  };
}

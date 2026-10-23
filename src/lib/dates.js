const WEEKDAYS = {
  dimanche: 0, dim: 0, lundi: 1, lun: 1, mardi: 2, mar: 2, mercredi: 3,
  mer: 3, jeudi: 4, jeu: 4, vendredi: 5, ven: 5, samedi: 6, sam: 6,
};

const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function at(base, { days = 0, h, m = 0 }) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  if (h !== undefined) d.setHours(h, m, 0, 0);
  else d.setHours(12, 0, 0, 0);
  return d;
}

/** Prochaine occurrence d'un jour de semaine : on ne planifie jamais dans le passé. */
function nextWeekday(now, target) {
  const delta = (target - now.getDay() + 7) % 7;
  return at(now, { days: delta === 0 ? 7 : delta });
}

function parseClock(text) {
  const m = /(?:a|vers|)\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return { h, m: Number(m[2] ?? 0) };
}

/**
 * Interprète les échéances écrites en français naturel.
 * Fichier volontairement table-driven : chaque variante est une ligne à ajouter.
 */
export function parseDueDate(input, now = new Date()) {
  if (!input) return null;
  const text = String(input).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const clock = parseClock(text);
  let date = null;
  let label = null;

  if (/\baujourd.hui\b/.test(text)) date = at(now, {});
  else if (/apres[- ]demain/.test(text)) date = at(now, { days: 2 });
  else if (/\bdemain\b/.test(text)) date = at(now, { days: 1 });
  else if (/hier/.test(text)) date = at(now, { days: -1 });
  else if (/la semaine prochaine|semaine pro/.test(text)) date = at(now, { days: 7 });
  else if (/fin de (le )?mois/.test(text)) {
    date = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12, 0, 0, 0);
  } else if (/\bdans (\d+|deux|trois|quatre|cinq) (jours?|semaines?|heures?|minutes?)\b/.test(text)) {
    const [, num, unit] = /\bdans (\d+|deux|trois|quatre|cinq) (jours?|semaines?|heures?|minutes?)\b/.exec(text);
    const words = { un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10 };
    const qty = words[num] ?? Number(num);
    if (/jour/.test(unit)) date = at(now, { days: qty });
    else if (/semaine/.test(unit)) date = at(now, { days: qty * 7 });
    else if (/heure/.test(unit)) date = at(now, { days: 0, h: now.getHours() + qty });
    else date = new Date(now.getTime() + qty * 60000);
  } else if (/\b(le )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.test(text)) {
    const [, , d, mo, y] = /\b(le )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
    date = new Date(Number(y ?? now.getFullYear()) < 100 ? 2000 + Number(y) : Number(y ?? now.getFullYear()), Number(mo) - 1, Number(d), 12);
    if (date < now && !y) date.setFullYear(date.getFullYear() + 1);
  } else if (/\b(\d{1,2})[ -]?(janv|fevr|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)\w*\.?/.test(text)) {
    const [, d, mon] = /\b(\d{1,2})[ -]?(janv|fevr|mars|avr|mai|juin|juil|aout|sept|oct|nov|dec)\w*\.?/.exec(text);
    const month = Object.entries(MONTHS).find(([name]) => name.startsWith(mon))?.[1];
    if (month) {
      date = new Date(now.getFullYear(), month - 1, Number(d), 12);
      if (date < now) date.setFullYear(date.getFullYear() + 1);
    }
  } else {
    const wd = Object.keys(WEEKDAYS).find((name) => new RegExp(`\\b${name}\\b`).test(text));
    if (wd) {
      date = nextWeekday(now, WEEKDAYS[wd]);
      label = wd;
    }
  }

  if (!date) {
    // "ce matin" / "ce soir" / "tout de suite"
    if (/ce matin/.test(text)) date = at(now, { h: 9 });
    else if (/ce (soir|fin de journee)/.test(text)) date = at(now, { h: 19 });
    else if (/tout de suite|maintenant|des que/.test(text)) date = at(now, {});
  }
  if (!date) return null;
  if (clock) {
    date.setHours(clock.h, clock.m, 0, 0);
  } else if (/matin/.test(text)) date.setHours(9);
  else if (/apres[- ]midi/.test(text)) date.setHours(15);
  else if (/soir/.test(text)) date.setHours(19);

  return {
    date: iso(date),
    time: clock ? `${pad(clock.h)}:${pad(clock.m)}` : null,
    datetime: date.toISOString(),
    label: `${label ? `${label} ` : ''}${iso(date)}${clock ? ` ${pad(clock.h)}:${pad(clock.m)}` : ''}`.trim(),
  };
}

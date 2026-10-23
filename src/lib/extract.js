import { parseDueDate } from '../lib/dates.js';
import { norm } from '../lib/filters.js';

const CATEGORIES = [
  ['devis', ['devis', 'prix', 'tarif', 'coute', 'combien', 'cotisation']],
  ['rdv', ['rdv', 'rendez vous', 'dispo', 'creneau', 'rencontrer', 'livraison', 'passe', 'passer']],
  ['sav', ['probleme', 'pane', 'casse', 'rembourse', 'litige', 'jamais livre', 'retour', 'reparation', 'erreur']],
  ['admin', ['facture', 'paiement', 'regle', 'cheque', 'virement', 'r.i.b', 'rib', 'relance']],
  ['vente', ['commande', 'veux', 'interesse', 'acheter', 'stock', 'livrer']],
];

/** Nettoyage d'une phrase vocale : on coupe les hésitations et on capitalise. */
function toTitle(text) {
  const clean = String(text ?? '')
    .replace(/\b(euh+|bonjour|salut|coucou|all[oô]|merci(?: beaucoup)?|s'?il te plait|s'?il vous plait|stp|svp)\b/gi, ' ')
    .replace(/[\s,'-]{2,}/g, ' ')
    .replace(/^[\s,.;:!'-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = clean.split(/[.!?]\s/)[0] ?? clean;
  const cut = sentence.length > 72 ? `${sentence.slice(0, 72).trimEnd()}…` : sentence;
  return cut ? cut.charAt(0).toUpperCase() + cut.slice(1) : '';
}

/**
 * Extraction sans IA : dates relatives françaises + catégorisation par mots-clés.
 * C'est le chemin par défaut de la démo (aucune clé requise) et le repli
 * automatique quand l'appel LLM échoue.
 */
export function heuristicTask(text, now = new Date()) {
  const due = parseDueDate(text, now);
  const lowered = norm(text);
  const category = CATEGORIES.find(([, keys]) => keys.some((key) => lowered.includes(key)))?.[0] ?? 'autre';
  return {
    title: toTitle(text) || 'Nouvelle demande WhatsApp',
    category,
    date: due?.date ?? null,
    time: due?.time ?? null,
    dueLabel: due?.label ?? null,
    raw: String(text ?? '').slice(0, 2000),
    source: 'heuristique',
  };
}

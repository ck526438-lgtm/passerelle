import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render, getPath, setPath } from '../src/lib/template.js';
import { matchesFilters, checkCondition, norm } from '../src/lib/filters.js';
import { parseDueDate } from '../src/lib/dates.js';
import { heuristicTask } from '../src/lib/extract.js';
import { validateRules } from '../src/rules.js';
import { ROOT } from '../src/config.js';

// Vendredi 23/10/2026 10:00, en heure locale pour que getDay() soit stable partout.
const NOW = new Date(2026, 9, 23, 10, 0);

test('gabarits : variables, valeurs par défaut et blocs conditionnels', () => {
  const scope = { task: { title: 'Devis salle de bain', dueLabel: '', category: 'devis' }, firstName: 'Awa', n: 0, list: [1, 2] };
  assert.equal(render('Bonjour {{firstName}}', scope), 'Bonjour Awa');
  assert.equal(render('{{task.titre ?? "Sans titre"}}', scope), 'Sans titre');
  assert.equal(render('« {{task.title}} »{{#task.dueLabel}} pour {{task.dueLabel}}{{/task.dueLabel}}', scope), '« Devis salle de bain »');
  assert.equal(render('{{^task.dueLabel}}sans échéance{{/task.dueLabel}}', scope), 'sans échéance');
  assert.equal(render('{{n}}|{{inconnu}}', scope), '0|');
  assert.equal(render('{{list}}', scope), '[1,2]');
});

test('chemins : lecture et écriture imbriquées', () => {
  const scope = {};
  setPath(scope, 'a.b', { x: 1 });
  assert.deepEqual(getPath(scope, 'a.b'), { x: 1 });
  assert.equal(getPath(scope, 'a.z.q'), undefined);
});

test('filtres : accent et casse ignorés', () => {
  const scope = { type: 'text', searchable: "J'ai besOin d'un Dévis ⚡" };
  assert.equal(matchesFilters({ text_contains_any: ['devis'] }, scope), true);
  assert.equal(matchesFilters({ text_contains_any: ['facture'] }, scope), false);
  assert.equal(matchesFilters({ types: ['audio'] }, scope), false);
  assert.equal(matchesFilters({ text_regex: '\\?$' }, scope), false);
  assert.equal(matchesFilters({ min_chars: 5, text_excludes_any: ['urgent'] }, scope), true);
  assert.equal(matchesFilters({ fields: { 'task.category': ['devis', 'rdv'] } }, { task: { category: 'RDV' }, searchable: '' }), true);
  assert.equal(norm('École'), 'ecole');
});

test('conditions d\'étape', () => {
  const scope = { transcript: 'je passe demain', empty: '', count: 3, flag: true };
  assert.equal(checkCondition({ path: 'transcript', op: 'contains', value: 'demain' }, scope), true);
  assert.equal(checkCondition({ path: 'empty', op: 'is_empty' }, scope), true);
  assert.equal(checkCondition({ path: 'missing', op: 'exists' }, scope), false);
  assert.equal(checkCondition({ path: 'count', op: 'gt', value: 2 }, scope), true);
  assert.equal(checkCondition({ path: 'flag', op: 'equals', value: true }, scope), true);
  assert.throws(() => checkCondition({ path: 'flag', op: 'tatouille' }, scope), /opérateur de condition inconnu/);
});

test('échéances en français naturel', () => {
  assert.equal(parseDueDate('passez demain', NOW).date, '2026-10-24');
  assert.equal(parseDueDate('après-demain matin', NOW).date, '2026-10-25');
  assert.equal(parseDueDate('demain à 14h30', NOW).time, '14:30');
  assert.equal(parseDueDate('dans 3 jours', NOW).date, '2026-10-26');
  assert.equal(parseDueDate('la semaine prochaine', NOW).date, '2026-10-30');
  assert.equal(parseDueDate('vendredi', NOW).date, '2026-10-30');
  assert.equal(parseDueDate('ce vendredi', NOW).date, '2026-10-30');
  assert.equal(parseDueDate('le 12/11', NOW).date, '2026-11-12');
  assert.equal(parseDueDate('fin de mois', NOW).date, '2026-10-31');
  assert.equal(parseDueDate('5 mai', NOW).date, '2027-05-05');
  assert.equal(parseDueDate('aucune date ici', NOW), null);
});

test('extraction heuristique : titre, catégorie, échéance', () => {
  const task = heuristicTask('Bonjour, je voudrais un devis pour refaire la salle de bain, vous pouvez passer demain à 14h ?', NOW);
  assert.equal(task.category, 'devis');
  assert.equal(task.date, '2026-10-24');
  assert.equal(task.time, '14:00');
  assert.match(task.title, /^Devis|Je voudrais/, `titre inattendu: ${task.title}`);
  assert.ok(!task.title.startsWith(','), 'le titre ne doit pas commencer par une ponctuation');
  assert.equal(heuristicTask('la machine est cassée, aidez-moi', NOW).category, 'sav');
  assert.equal(heuristicTask('', NOW).category, 'autre');
});

test('le rules.json livré est valide', () => {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
  const { rules, problems } = validateRules(document);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(rules.length >= 4, 'au moins 4 règles livrées');
  assert.ok(rules.every((rule) => rule.id), 'chaque règle a un id');
});

test('validateRules refuse les id dupliqués et les actions inconnues', () => {
  const { problems } = validateRules({ rules: [
    { id: 'a', steps: [{ action: 'reply' }] },
    { id: 'a', steps: [{ action: 'envoyer_un_fax' }] },
    { name: 'sans id', steps: [] },
  ] });
  assert.ok(problems.some((p) => p.includes('dupliqué')));
  assert.ok(problems.some((p) => p.includes('action inconnue')));
  assert.ok(problems.some((p) => p.includes('"id" manquant')));
});

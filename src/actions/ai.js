import { request } from '../lib/http.js';
import { heuristicTask } from '../lib/extract.js';
import { parseDueDate } from '../lib/dates.js';
import { render } from '../lib/template.js';

export const aiActions = {
  parse_task: {
    label: 'Structurer la demande (sans IA)',
    description: 'Titre, échéance en français et catégorie, par heuristiques. Zéro clé API, zéro coût.',
    async run(step, ctx) {
      const source = step.source ? render(step.source, ctx.scope) : (ctx.scope.searchable ?? '');
      const task = heuristicTask(source, ctx.now?.() ?? new Date());
      if (step.defaults) Object.assign(task, step.defaults);
      return { output: task, category: task.category, due: task.dueLabel };
    },
  },

  llm_extract: {
    label: 'Structurer la demande avec l\'IA',
    description: 'Appelle un LLM (format JSON) pour extraire titre/category/contact, puis recalcule la date localement.',
    async run(step, ctx) {
      const { config, log } = ctx;
      const source = step.source ? render(step.source, ctx.scope) : (ctx.scope.searchable ?? '');
      if (!source.trim()) throw new Error('llm_extract: rien à extraire');

      const heuristic = heuristicTask(source, ctx.now?.() ?? new Date());
      if (!config.llm.apiKey) {
        log.warn('LLM non configuré, repli sur les heuristiques');
        return { output: heuristic, fallback: true };
      }

      const schema = step.schema ?? { title: 'string (impératif, 12 mots max)', category: `string (un de: ${CATEGORY_HINT})`, contact: 'string (nom cité, ou vide)', note: 'string (résumé en 1 phrase, ou vide)' };
      const { json } = await request(`${trimSlash(config.llm.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.llm.apiKey}`, 'content-type': 'application/json' },
        body: {
          model: step.model ?? config.llm.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `Tu extrais les informations d'un message WhatsApp destiné à un artisan/commerçant français. Réponds avec un objet JSON plat respectant exactement ce schéma : ${JSON.stringify(schema)}.${step.instructions ? ` ${step.instructions}` : ''}` },
            { role: 'user', content: source },
          ],
        },
        timeoutMs: step.timeoutMs ?? 30000,
        maxBytes: 1024 * 1024,
      });

      let parsed = {};
      try {
        parsed = JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
      } catch (error) {
        log.warn('LLM a renvoyé un JSON invalide, repli heuristique', { error: String(error) });
        return { output: heuristic, fallback: true };
      }
      // L'IA est mauvaise sur les dates relatives : on garde la sienne seulement si elle est ISO.
      const local = parseDueDate(source, new Date());
      const isoFromLlm = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date ?? '')) ? parsed.date : null;
      return {
        output: {
          ...heuristic,
          ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null && v !== '')),
          date: isoFromLlm ?? local?.date ?? heuristic.date,
          time: parsed.time ?? local?.time ?? heuristic.time,
          dueLabel: local?.label ?? heuristic.dueLabel,
          source: 'llm',
        },
        model: json?.model,
        tokens: json?.usage?.total_tokens,
      };
    },
  },

  llm_generate: {
    label: 'Générer un texte (réponse IA)',
    description: 'Rédige une réponse libre à partir d\'un prompt, sortie dans une variable utilisable par `reply`.',
    async run(step, ctx) {
      const { config } = ctx;
      const prompt = render(step.prompt ?? '', ctx.scope);
      if (!config.llm.apiKey) throw new Error('llm_generate: OPENAI_API_KEY requis');
      const { json } = await request(`${trimSlash(config.llm.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.llm.apiKey}`, 'content-type': 'application/json' },
        body: {
          model: step.model ?? config.llm.model,
          temperature: step.temperature ?? 0.4,
          messages: [
            ...(step.system ? [{ role: 'system', content: render(step.system, ctx.scope) }] : []),
            { role: 'user', content: prompt },
          ],
        },
        maxBytes: 1024 * 1024,
      });
      const text = json?.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) throw new Error('llm_generate: réponse vide');
      return { output: text, tokens: json?.usage?.total_tokens };
    },
  },
};

const CATEGORY_HINT = 'devis, rdv, sav, admin, vente, autre';
const trimSlash = (u) => String(u).replace(/\/+$/, '');

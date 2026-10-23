import { render } from '../lib/template.js';

export const whatsappActions = {
  reply: {
    label: 'Répondre sur WhatsApp',
    description: 'Envoie un message texte dans la conversation d\'origine.',
    async run(step, ctx) {
      const templates = step.templates ?? [step.template ?? step.text ?? ''];
      const chosen = Array.isArray(templates) ? templates[Math.floor(Math.random() * templates.length)] : templates;
      const text = render(chosen, ctx.scope).trim();
      if (!text) throw new Error('reply: message vide après rendu des variables');
      if (text.length > 4096) throw new Error(`reply: ${text.length} caractères, max 4096`);
      const result = await ctx.messenger.sendText(ctx.msg.chatId, text, { replyTo: step.quote ? ctx.msg.id : undefined });
      ctx.store?.events?.append({
        kind: 'outbound',
        messageId: result?.id ?? `sent-${Date.now()}`,
        chatId: ctx.msg.chatId,
        type: 'text',
        text: text.slice(0, 1500),
        provider: ctx.messenger.provider,
        ruleId: ctx.ruleId,
      });
      return { sent: true, to: ctx.msg.chatId, chars: text.length, id: result?.id, simulated: result?.simulated, text };
    },
  },

  mark_read: {
    label: 'Marquer comme lu',
    description: 'Envoie les cochéj bleus. Utile pour donner un signal de réactivité.',
    async run(step, ctx) {
      await ctx.messenger.markAsRead?.(ctx.msg.id);
      return { read: true };
    },
  },

  assign_contact: {
    label: 'Mémoriser le contact',
    description: 'Enregistre le numéro et le nom dans le carnet local (tableau `contacts`).',
    async run(step, ctx) {
      const record = {
        kind: 'contact',
        messageId: `contact:${ctx.msg.chatId}`,
        chatId: ctx.msg.chatId,
        name: ctx.msg.contactName ?? null,
        lastText: (ctx.scope.searchable ?? '').slice(0, 200),
      };
      ctx.store.contacts.append(record);
      return record;
    },
  },
};

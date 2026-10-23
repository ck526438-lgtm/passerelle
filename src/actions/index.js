import { whatsappActions } from './whatsapp.js';
import { mediaActions } from './media.js';
import { aiActions } from './ai.js';
import { notionActions } from './notion.js';
import { sheetsActions } from './sheets.js';
import { airtableActions, genericActions } from './destinations.js';

/** Registre unique : les règles ne référencent que des noms d'action. */
export const actions = {
  ...whatsappActions,
  ...mediaActions,
  ...aiActions,
  ...notionActions,
  ...sheetsActions,
  ...airtableActions,
  ...genericActions,
};

export function describeActions() {
  return Object.entries(actions).map(([name, def]) => ({ name, label: def.label, description: def.description }));
}

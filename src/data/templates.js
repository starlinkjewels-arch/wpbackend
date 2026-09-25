/** Saved messages — the new-arrivals note, the festive greeting, the price-list
 *  cover message — so nobody retypes them for each campaign. */
import { templates, newId } from "./collections.js";
import { fail } from "./contacts.js";

function clean(input) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const message = String(input.message ?? "").slice(0, 4000);
  if (!name) throw fail("Give the template a name");
  if (!message.trim() && !input.mediaId) throw fail("Write a message or attach a file");
  return { name, message, mediaId: input.mediaId || null };
}

export function listTemplates() {
  return templates.all().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function createTemplate(input) {
  const now = Date.now();
  return templates.put(newId("t"), { ...clean(input), createdAt: now, updatedAt: now });
}

export async function updateTemplate(id, input) {
  if (!templates.has(id)) throw fail("Template not found", "NOT_FOUND", 404);
  return templates.patch(id, { ...clean({ ...templates.get(id), ...input }), updatedAt: Date.now() });
}

export async function deleteTemplate(id) {
  await templates.remove(id);
}

/** A starting set, so the Templates page is not empty on day one. */
export const STARTER_TEMPLATES = [
  {
    name: "New arrivals",
    message:
      "{Hello|Hi|Dear} {{first_name|Sir/Madam}},\n\nOur *new collection* of certified diamond jewellery is ready. Fresh designs in rings, earrings and bracelets — with GIA / IGI certified stones.\n\nReply *YES* and we will share the full catalogue with prices.\n\n— {{business_name}}",
  },
  {
    name: "Price list follow-up",
    message:
      "{Hello|Hi} {{first_name|there}},\n\nSharing our latest price list for {{company|your business}}. Special B2B rates apply on orders placed this week.\n\nLet us know which pieces interest you and we will send details and videos.",
  },
  {
    name: "Trade show invite",
    message:
      "Dear {{first_name|Sir/Madam}},\n\nWe will be at the upcoming jewellery show. We would love to meet you and show the new collection in person.\n\nReply with a convenient time and we will book a slot for you.\n\n— {{business_name}}",
  },
];

export async function seedTemplatesIfEmpty() {
  if (templates.size) return;
  const now = Date.now();
  await templates.putMany(STARTER_TEMPLATES.map((t, i) => ({ ...t, id: newId("t"), mediaId: null, createdAt: now - i, updatedAt: now - i })));
}

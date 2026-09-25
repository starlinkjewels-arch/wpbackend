/**
 * One message, written once, read by each client as if it were written to them.
 *
 *   {{name}}              the client's name
 *   {{name|Sir}}          …or "Sir" when the client has no name saved
 *   {{company}}, {{city}}, {{country}}, any column from their Excel sheet
 *   {Hello|Hi|Dear}       one of these, picked at random per client
 *
 * The random pick is not decoration. A thousand byte-identical messages from
 * one number is the pattern WhatsApp's spam detection looks for; the same
 * message in a few wordings is what a person sending by hand produces.
 *
 * Pure. The random source is injectable so the tests can pin it.
 */

const TITLES = /^(mr|mrs|ms|miss|dr|shri|sri|smt|sir|madam|mx|prof)\.?$/i;

/** Variable names are matched loosely: {{First Name}}, {{first_name}} and
 *  {{firstname}} are one variable. */
export function varKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Built-in variables every client has, in the order the composer offers them. */
export const BUILT_IN_VARS = [
  { key: "name", label: "Name" },
  { key: "first_name", label: "First name" },
  { key: "company", label: "Company" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
];

export function firstName(fullName) {
  const words = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.test(words[0])) words.shift();
  return words[0] ?? "";
}

/** Everything a template may refer to, for one contact. */
export function varsForContact(contact = {}, extra = {}) {
  const vars = {};
  const put = (k, v) => {
    if (v != null && String(v).trim() !== "") vars[varKey(k)] = String(v).trim();
  };
  for (const [k, v] of Object.entries(contact.fields ?? {})) put(k, v);
  put("name", contact.name);
  put("first_name", firstName(contact.name));
  put("company", contact.company);
  put("city", contact.city);
  put("country", contact.countryName ?? contact.country);
  put("phone", contact.phone ? "+" + contact.phone : "");
  put("email", contact.email);
  for (const [k, v] of Object.entries(extra)) put(k, v);
  return vars;
}

const VAR_RE = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;
const SPIN_RE = /\{([^{}]*\|[^{}]*)\}/;

/** Which variables a template uses, and whether each has a fallback. */
export function templateVars(template) {
  const out = new Map();
  for (const m of String(template ?? "").matchAll(VAR_RE)) {
    const key = varKey(m[1]);
    const prev = out.get(key);
    out.set(key, { key, label: m[1].trim(), hasFallback: Boolean(m[2]) && (prev?.hasFallback ?? true) });
  }
  return [...out.values()];
}

export function renderMessage(template, vars = {}, { random = Math.random } = {}) {
  let text = String(template ?? "");

  /* Values go in last, behind placeholders, so a client whose company is
     called "A{B|C}" is not put through the spintax pass. */
  const values = [];
  text = text.replace(VAR_RE, (_m, name, fallback) => {
    const v = vars[varKey(name)];
    values.push(v != null && v !== "" ? v : (fallback ?? ""));
    return `\u0000${values.length - 1}\u0000`;
  });

  // Innermost first, so {Hi|{Hello|Hey} there} works.
  for (let guard = 0; guard < 200; guard += 1) {
    const m = text.match(SPIN_RE);
    if (!m) break;
    const options = m[1].split("|");
    const pick = options[Math.min(options.length - 1, Math.floor(random() * options.length))];
    text = text.slice(0, m.index) + pick + text.slice(m.index + m[0].length);
  }

  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i) => values[Number(i)]);

  // A missing value leaves "Dear ," or a double space behind. Tidy what we made.
  return text
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * For the composer's warnings: how many of these contacts would get an empty
 * value for each variable that has no fallback.
 */
export function missingVarCounts(template, contacts) {
  const used = templateVars(template).filter((v) => !v.hasFallback);
  const out = [];
  for (const v of used) {
    let missing = 0;
    for (const c of contacts) if (!varsForContact(c)[v.key]) missing += 1;
    if (missing) out.push({ key: v.key, label: v.label, missing });
  }
  return out;
}

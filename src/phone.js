/**
 * Turning whatever is in a spreadsheet cell into a WhatsApp number.
 *
 * The clients are abroad — Dubai, Antwerp, Hong Kong, New York, Tel Aviv — and
 * their numbers arrive every way a person can type them: "+971 50 123 4567",
 * "00971501234567", "0501234567" next to a Country column saying "UAE",
 * "971501234567" with no plus, two numbers in one cell, and the one Excel does
 * to all of them if the column is not Text: 9.71501E+11. Every one of those
 * has to become either a number or a sentence saying why not, because a wrong
 * guess sends a diamond price list to a stranger.
 *
 * The result's `phone` is digits only, country code first, no plus — the
 * form WhatsApp addresses people by, and the id a contact is stored under.
 */
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from "libphonenumber-js/max";

const COUNTRIES = new Set(getCountries());

/* Names people actually write in a Country column, beyond the official ones
   Intl knows. Lower-case, punctuation stripped. */
const ALIASES = {
  uae: "AE", "u a e": "AE", emirates: "AE", dubai: "AE", "abu dhabi": "AE", sharjah: "AE",
  usa: "US", "u s a": "US", us: "US", america: "US", "united states of america": "US",
  uk: "GB", "u k": "GB", england: "GB", britain: "GB", "great britain": "GB", london: "GB",
  hk: "HK", "hong kong": "HK", hongkong: "HK", "hong kong sar": "HK",
  ksa: "SA", saudi: "SA", "saudi arabia": "SA", riyadh: "SA", jeddah: "SA",
  antwerp: "BE", belgium: "BE", israel: "IL", "ramat gan": "IL", "tel aviv": "IL",
  india: "IN", bharat: "IN", surat: "IN", mumbai: "IN",
  russia: "RU", "south korea": "KR", korea: "KR", "north korea": "KP",
  china: "CN", prc: "CN", taiwan: "TW", thailand: "TH", bangkok: "TH",
  singapore: "SG", switzerland: "CH", swiss: "CH", geneva: "CH",
  holland: "NL", netherlands: "NL", "the netherlands": "NL",
  qatar: "QA", doha: "QA", oman: "OM", kuwait: "KW", bahrain: "BH",
  turkey: "TR", turkiye: "TR", "sri lanka": "LK", japan: "JP", australia: "AU",
};

let nameMap = null;
function countryNames() {
  if (nameMap) return nameMap;
  nameMap = new Map(Object.entries(ALIASES));
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of COUNTRIES) {
      const name = dn.of(code);
      if (name) nameMap.set(simplify(name), code);
    }
  } catch {
    /* no ICU data — the aliases still cover the common ones */
  }
  return nameMap;
}

function simplify(s) {
  return String(s).toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** "UAE", "United Arab Emirates", "ae", "+971", "971" -> "AE". Null when unsure. */
export function countryFromText(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && COUNTRIES.has(upper)) return upper;
  const digits = raw.replace(/\D/g, "");
  if (digits && /^\+?\d[\d\s-]*$/.test(raw)) return countryFromCallingCode(digits);
  return countryNames().get(simplify(raw)) ?? null;
}

const MAIN_COUNTRY_FOR_CODE = { 1: "US", 7: "RU", 44: "GB", 61: "AU", 971: "AE", 91: "IN", 852: "HK", 972: "IL", 32: "BE" };

function countryFromCallingCode(code) {
  if (MAIN_COUNTRY_FOR_CODE[code]) return MAIN_COUNTRY_FOR_CODE[code];
  for (const c of COUNTRIES) if (getCountryCallingCode(c) === code) return c;
  return null;
}

export function callingCodeFor(country) {
  try {
    return country && COUNTRIES.has(country) ? getCountryCallingCode(country) : null;
  } catch {
    return null;
  }
}

/** The cell as a string, without the damage Excel does on the way. */
function cellToString(value) {
  if (value == null) return "";
  if (typeof value === "number") {
    // A number cell that is really a phone number: 971501234567 is exact as a
    // double, and String() would print it that way. A fraction is not a phone.
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  // A leading apostrophe is how Excel is told "this is text": '+971…
  return String(value).trim().replace(/^['‘’`]+/, "").trim();
}

const SPLITTERS = /\s*(?:[,;|\/\n]|\bor\b|&)\s*/i;

/**
 * @param {unknown} input            the cell
 * @param {object}  opts
 * @param {string}  [opts.defaultCountry]  ISO-2 used when the number has no country code
 * @param {string}  [opts.country]         this row's Country column, if any — beats the default
 * @param {string}  [opts.callingCode]     this row's separate "Country code" column, if any
 * @returns {{ok: true, phone: string, e164: string, country: string|null, warning?: string, others?: string[]}
 *          | {ok: false, error: string}}
 */
export function normalizePhone(input, opts = {}) {
  let text = cellToString(input);
  if (!text) return { ok: false, error: "No phone number" };

  if (/\d[.,]\d+e\+?\d+/i.test(text)) {
    return {
      ok: false,
      error:
        "Excel shortened this number (it shows as " + text + "). Set the column to Text in Excel and re-save",
    };
  }

  // Two numbers in one cell: use the first, keep the rest so nothing is lost.
  let others;
  const parts = text.split(SPLITTERS).filter((p) => /\d{6,}/.test(p.replace(/\D/g, "")));
  if (parts.length > 1) {
    text = parts[0];
    others = parts.slice(1).map((p) => p.trim());
  }

  // "+91 98250 12345 (WhatsApp)", "Mob: 98250-12345", "ext. 12" — keep the number.
  text = text.replace(/\b(ext|extn|x)\.?\s*\d+\s*$/i, "");
  const hasPlus = /^\s*\+/.test(text) || /^\s*(?:\(?\s*)00[1-9]/.test(text);
  let digits = text.replace(/\D/g, "");
  if (/^00[1-9]/.test(digits)) digits = digits.slice(2);
  if (digits.length < 6) return { ok: false, error: "Too short to be a phone number" };
  if (digits.length > 15) return { ok: false, error: "Too long to be a phone number" };

  const rowCountry = countryFromText(opts.country);
  const home = rowCountry || (COUNTRIES.has(opts.defaultCountry) ? opts.defaultCountry : undefined);
  const codeHint = cellToString(opts.callingCode).replace(/\D/g, "");

  const candidates = [];
  if (hasPlus) {
    candidates.push(parsePhoneNumberFromString("+" + digits));
  } else {
    if (codeHint && !digits.startsWith(codeHint)) {
      candidates.push(parsePhoneNumberFromString("+" + codeHint + digits.replace(/^0+/, "")));
    }
    if (home) candidates.push(parsePhoneNumberFromString(digits, home));
    // Written with its country code but no plus: 971501234567.
    candidates.push(parsePhoneNumberFromString("+" + digits));
  }

  const parsed = candidates.filter(Boolean);
  const valid = parsed.find((p) => p.isValid());
  const possible = parsed.filter((p) => p.isPossible());
  /* Neither reading is a known number range. Eleven digits or more is longer
     than almost any national number, so it most likely already carries its
     country code — prefer that reading over bolting the default country on. */
  const intl = possible.find((p) => p.number === "+" + digits);
  const chosen = valid ?? (digits.length >= 11 && intl ? intl : possible[0]);
  if (!chosen) {
    return {
      ok: false,
      error: hasPlus || home
        ? "Not a valid phone number"
        : "Add the country code (like +971) or choose a default country",
    };
  }

  const result = {
    ok: true,
    phone: chosen.number.replace(/^\+/, ""),
    e164: chosen.number,
    country: chosen.country ?? null,
  };
  if (!valid) result.warning = "Unusual number — it will be checked on WhatsApp before sending";
  if (others) result.others = others;
  return result;
}

/** "+971 50 123 4567" for display. Falls back to +digits. */
export function formatPhone(phone) {
  if (!phone) return "";
  const p = parsePhoneNumberFromString("+" + String(phone).replace(/\D/g, ""));
  return p ? p.formatInternational() : "+" + phone;
}

/**
 * A client's clock and weekend, from their country.
 *
 * One zone per country — the business centre. Countries that span several
 * zones get the one most B2B buyers sit in (US → New York, Australia → Sydney,
 * Russia → Moscow). Near enough for "is it office hours there?", which is all
 * this is used for.
 *
 * Weekends differ, and it matters for this business: the Gulf and Israel rest
 * Friday–Saturday, so a Friday message to Riyadh lands on their Sunday.
 */
const ZONES = {
  IN: "Asia/Kolkata", AE: "Asia/Dubai", SA: "Asia/Riyadh", QA: "Asia/Qatar", KW: "Asia/Kuwait", BH: "Asia/Bahrain",
  OM: "Asia/Muscat", IL: "Asia/Jerusalem", JO: "Asia/Amman", LB: "Asia/Beirut", EG: "Africa/Cairo", TR: "Europe/Istanbul",
  IR: "Asia/Tehran", PK: "Asia/Karachi", BD: "Asia/Dhaka", LK: "Asia/Colombo", NP: "Asia/Kathmandu",
  HK: "Asia/Hong_Kong", CN: "Asia/Shanghai", TW: "Asia/Taipei", JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", ID: "Asia/Jakarta", PH: "Asia/Manila",
  AU: "Australia/Sydney", NZ: "Pacific/Auckland",
  GB: "Europe/London", IE: "Europe/Dublin", BE: "Europe/Brussels", NL: "Europe/Amsterdam", FR: "Europe/Paris",
  DE: "Europe/Berlin", IT: "Europe/Rome", ES: "Europe/Madrid", PT: "Europe/Lisbon", CH: "Europe/Zurich",
  AT: "Europe/Vienna", DK: "Europe/Copenhagen", SE: "Europe/Stockholm", NO: "Europe/Oslo", FI: "Europe/Helsinki",
  PL: "Europe/Warsaw", CZ: "Europe/Prague", GR: "Europe/Athens", RU: "Europe/Moscow", UA: "Europe/Kyiv",
  US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City", BR: "America/Sao_Paulo",
  AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago", CO: "America/Bogota", PE: "America/Lima",
  ZA: "Africa/Johannesburg", NG: "Africa/Lagos", KE: "Africa/Nairobi", MA: "Africa/Casablanca", BW: "Africa/Gaborone",
  AO: "Africa/Luanda", NA: "Africa/Windhoek", MU: "Indian/Mauritius",
};

/** 0 = Sunday … 6 = Saturday. */
const FRI_SAT = [5, 6];
const SAT_SUN = [6, 0];
const WEEKENDS = { SA: FRI_SAT, QA: FRI_SAT, KW: FRI_SAT, BH: FRI_SAT, OM: FRI_SAT, IL: FRI_SAT, JO: FRI_SAT, EG: FRI_SAT, IR: [5] };

export function timezoneFor(country, fallback) {
  return ZONES[country] ?? fallback;
}

export function weekendFor(country) {
  return WEEKENDS[country] ?? SAT_SUN;
}

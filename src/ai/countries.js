/** "AE" -> "United Arab Emirates", for prompts. Anything else passes through. */
let names = null;

export function countryName(code) {
  if (!code) return "";
  if (!/^[A-Z]{2}$/.test(code)) return String(code);
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

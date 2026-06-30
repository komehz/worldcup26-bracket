// FIFA 3-letter code -> flagcdn (ISO 3166-1 alpha-2, plus a few subdivisions).
// Flags only, never official crests, to keep clear of trademark questions.
const FIFA_TO_ISO = {
  CAN: "ca", RSA: "za", PAR: "py", GER: "de", MAR: "ma", NED: "nl",
  BRA: "br", JPN: "jp", CIV: "ci", NOR: "no", FRA: "fr", SWE: "se",
  MEX: "mx", ECU: "ec", ENG: "gb-eng", COD: "cd", BEL: "be", SEN: "sn",
  USA: "us", BIH: "ba", ESP: "es", AUT: "at", POR: "pt", CRO: "hr",
  SUI: "ch", ALG: "dz", ARG: "ar", CPV: "cv", AUS: "au", EGY: "eg",
  COL: "co", GHA: "gh",
};

// flagcdn serves crisp PNGs at fixed widths; w320 is plenty for a card face.
export function flagUrl(code, width = 320) {
  const iso = code && FIFA_TO_ISO[code.toUpperCase()];
  if (!iso) return null;
  return `https://flagcdn.com/w${width}/${iso}.png`;
}

export function hasFlag(code) {
  return Boolean(code && FIFA_TO_ISO[code.toUpperCase()]);
}

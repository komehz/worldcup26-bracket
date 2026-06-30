// FIFA 3-letter code -> flagcdn (ISO 3166-1 alpha-2, plus a few subdivisions).
// Flags only, never crests, to keep clear of trademark questions. Covers the
// 48 teams of the 2026 finals (codes match football-data.org's tla field).
const FIFA_TO_ISO = {
  ALG: "dz", ARG: "ar", AUS: "au", AUT: "at", BEL: "be", BIH: "ba",
  BRA: "br", CAN: "ca", CIV: "ci", COD: "cd", COL: "co", CPV: "cv",
  CRO: "hr", CUW: "cw", CZE: "cz", ECU: "ec", EGY: "eg", ENG: "gb-eng",
  ESP: "es", FRA: "fr", GER: "de", GHA: "gh", HAI: "ht", IRN: "ir",
  IRQ: "iq", JOR: "jo", JPN: "jp", KOR: "kr", KSA: "sa", MAR: "ma",
  MEX: "mx", NED: "nl", NOR: "no", NZL: "nz", PAN: "pa", PAR: "py",
  POR: "pt", QAT: "qa", RSA: "za", SCO: "gb-sct", SEN: "sn", SUI: "ch",
  SWE: "se", TUN: "tn", TUR: "tr", URU: "uy", USA: "us", UZB: "uz",
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

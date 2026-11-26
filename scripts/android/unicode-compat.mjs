/**
 * Build-time half of the Unicode compatibility layer for the embedded Node.js.
 *
 * nodejs-mobile's Node is built WITHOUT ICU: regular expressions with Unicode property escapes (\p{L}, \p{Script=Han}),
 * `String.prototype.normalize` and the whole `Intl` object are missing, and a single `/\p{L}/u` anywhere in the
 * code is a SyntaxError that stops the file from loading at all. This module
 *
 *   1. rewrites every regex LITERAL that uses a property escape into `new RegExp("…", flags)` — a call, so the
 *      file parses everywhere and the runtime layer (android-backend/src/unicode.ts) can expand the escape;
 *   2. generates the data that layer needs (code-point ranges per property, and decomposition tables for
 *      normalize), from the full-ICU Node that runs the build.
 *
 * The rewrite uses a real parser (acorn), so it can tell a regex literal from a division or a string.
 */

/** True if the regex source has an UNESCAPED-backslash \p{ or \P{ (a `\\p{` is a literal backslash + "p{"). */
export function hasPropertyEscape(src) {
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "\\") continue;
    const n = src[i + 1];
    if ((n === "p" || n === "P") && src[i + 2] === "{") return true;
    i++; // skip the escaped character
  }
  return false;
}

/** Property names used by \p{…} / \P{…}, in regex source or in string literals ("\\p{L}"). */
export function collectPropertyNames(code, into = new Set()) {
  const re = /\\{1,2}[pP]\{([^}\\]{1,64})\}/g;
  let m;
  while ((m = re.exec(code))) into.add(m[1]);
  return into;
}

/**
 * Rewrites regex literals with property escapes into `new RegExp(...)` calls.
 * @param {string} code
 * @param {typeof import("acorn")} acorn
 * @returns {{ code: string, count: number }}
 */
export function rewriteRegexLiterals(code, acorn) {
  // Cheap pre-check: most files have none.
  if (!/\\[pP]\{/.test(code)) return { code, count: 0 };
  const tokens = [];
  const options = (sourceType) => ({
    ecmaVersion: "latest",
    sourceType,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    onToken: (t) => {
      if (t.type === acorn.tokTypes.regexp) tokens.push({ start: t.start, end: t.end });
    },
  });
  try {
    acorn.parse(code, options("script"));
  } catch (scriptErr) {
    tokens.length = 0;
    try {
      acorn.parse(code, options("module"));
    } catch {
      throw scriptErr;
    }
  }
  let out = "";
  let last = 0;
  let count = 0;
  for (const t of tokens) {
    const text = code.slice(t.start, t.end);
    const slash = text.lastIndexOf("/");
    const pattern = text.slice(1, slash);
    const flags = text.slice(slash + 1);
    if (!hasPropertyEscape(pattern)) continue;
    out += code.slice(last, t.start) + `new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})`;
    last = t.end;
    count++;
  }
  out += code.slice(last);
  return { code: out, count };
}

/* ------------------------------------------------------------------ data */

const SCRIPTS = [
  "Latin", "Han", "Hiragana", "Katakana", "Hangul", "Cyrillic", "Greek", "Arabic", "Hebrew", "Thai",
  "Devanagari", "Bengali", "Tamil", "Telugu", "Gujarati", "Gurmukhi", "Kannada", "Malayalam", "Armenian",
  "Georgian", "Ethiopic", "Khmer", "Lao", "Myanmar", "Sinhala", "Tibetan", "Bopomofo", "Common", "Inherited",
];

const DEFAULT_PROPERTIES = [
  // general categories, short and long
  "L", "Lu", "Ll", "Lt", "Lm", "Lo", "LC", "M", "Mn", "Mc", "Me", "N", "Nd", "Nl", "No", "P", "Pc", "Pd", "Ps", "Pe",
  "Pi", "Pf", "Po", "S", "Sm", "Sc", "Sk", "So", "Z", "Zs", "Zl", "Zp", "C", "Cc", "Cf", "Cs", "Co",
  "Letter", "Uppercase_Letter", "Lowercase_Letter", "Titlecase_Letter", "Modifier_Letter", "Other_Letter",
  "Mark", "Nonspacing_Mark", "Spacing_Mark", "Enclosing_Mark", "Number", "Decimal_Number", "Letter_Number",
  "Other_Number", "Punctuation", "Connector_Punctuation", "Dash_Punctuation", "Open_Punctuation",
  "Close_Punctuation", "Initial_Punctuation", "Final_Punctuation", "Other_Punctuation", "Symbol", "Math_Symbol",
  "Currency_Symbol", "Modifier_Symbol", "Other_Symbol", "Separator", "Space_Separator", "Line_Separator",
  "Paragraph_Separator", "Other", "Control", "Format", "Surrogate", "Private_Use", "Cased_Letter",
  // binary properties
  "Alphabetic", "Alpha", "White_Space", "space", "Uppercase", "Upper", "Lowercase", "Lower", "ID_Start", "IDS",
  "ID_Continue", "IDC", "Emoji", "Emoji_Presentation", "Extended_Pictographic", "Emoji_Modifier",
  "Emoji_Modifier_Base", "Emoji_Component", "Any", "ASCII", "Assigned", "Ideographic", "Math", "Hex_Digit",
  "ASCII_Hex_Digit", "Dash", "Diacritic", "Variation_Selector", "Regional_Indicator",
  // scripts
  ...SCRIPTS.flatMap((s) => [`Script=${s}`, `sc=${s}`, `Script_Extensions=${s}`, `scx=${s}`]),
];

function rangesFor(name) {
  let re;
  try {
    re = new RegExp(`^\\p{${name}}$`, "u");
  } catch {
    return null;
  }
  return re;
}

/** Flat [lo, hi, lo, hi, ...] hex string per property: "41-5A,61-7A,AA". */
function propertyTable(names) {
  const res = [];
  for (const name of names) {
    const re = rangesFor(name);
    if (re) res.push({ name, re, runs: [], lo: -1 });
  }
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const ch = String.fromCodePoint(cp); // lone surrogates stay lone, which /u treats as one code point
    for (const p of res) {
      if (p.re.test(ch)) {
        if (p.lo < 0) p.lo = cp;
      } else if (p.lo >= 0) {
        p.runs.push([p.lo, cp - 1]);
        p.lo = -1;
      }
    }
  }
  const out = {};
  for (const p of res) {
    if (p.lo >= 0) p.runs.push([p.lo, 0x10ffff]);
    out[p.name] = p.runs.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(",");
  }
  return out;
}

const hex = (cps) => [...cps].map((c) => c.codePointAt(0).toString(16)).join(" ");

/** Decomposition and composition tables for String.prototype.normalize. */
function normalizationTables() {
  const d = {}; // canonical full decomposition (NFD) where it differs from the character itself
  const k = {}; // compatibility full decomposition (NFKD) where it differs from NFD
  const pairs = {}; // "first second" → composite, for NFC/NFKC (primary composites only)
  const isHangulSyllable = (cp) => cp >= 0xac00 && cp <= 0xd7a3;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if ((cp >= 0xd800 && cp <= 0xdfff) || isHangulSyllable(cp)) continue;
    const ch = String.fromCodePoint(cp);
    const nfd = ch.normalize("NFD");
    const nfkd = ch.normalize("NFKD");
    if (nfd !== ch) d[cp.toString(16)] = hex(nfd);
    if (nfkd !== nfd) k[cp.toString(16)] = hex(nfkd);
    if (nfd !== ch && [...nfd].length >= 2 && ch.normalize("NFC") === ch) {
      const cps = [...nfd];
      const last = cps[cps.length - 1];
      const head = cps.slice(0, -1).join("").normalize("NFC");
      if ([...head].length === 1 && (head + last).normalize("NFC") === ch) {
        pairs[`${head.codePointAt(0).toString(16)} ${last.codePointAt(0).toString(16)}`] = cp.toString(16);
      }
    }
  }
  // Canonical combining classes, without a UCD: a mark with 0 < ccc < 240 moves in front of U+0345 (ccc 240) when
  // normalized, so the probe finds every non-starter; a comparison sort against native normalize ranks them.
  const nonStarters = [];
  for (let c = 0x300; c <= 0x10ffff; c++) {
    if ((c >= 0xd800 && c <= 0xdfff) || d[c.toString(16)] || k[c.toString(16)]) continue;
    const ch = String.fromCodePoint(c);
    if (c === 0x345 || [..."a\u0345".concat(ch).normalize("NFD")][1] === ch) nonStarters.push(c);
  }
  const nfd = (s) => s.normalize("NFD");
  const cmp = (a, b) => {
    if (a === b) return 0;
    const A = String.fromCodePoint(a);
    const B = String.fromCodePoint(b);
    if (nfd("x" + A + B) === "x" + B + A) return 1; // b sorts first: ccc(a) > ccc(b)
    if (nfd("x" + B + A) === "x" + A + B) return -1; // a sorts first: ccc(a) < ccc(b)
    return 0; // equal classes keep their order
  };
  // Insertion into ordered groups: ranks are dense integers, equal classes share one.
  const groups = []; // each: array of cps with equal ccc, ordered ascending by ccc
  for (const c of nonStarters) {
    let placed = false;
    for (let i = 0; i < groups.length && !placed; i++) {
      const r = cmp(c, groups[i][0]);
      if (r === 0) {
        groups[i].push(c);
        placed = true;
      } else if (r < 0) {
        groups.splice(i, 0, [c]);
        placed = true;
      }
    }
    if (!placed) groups.push([c]);
  }
  const o = [];
  groups.forEach((g, i) => g.forEach((c) => o.push(`${c.toString(16)}:${i + 1}`)));
  return { d, k, c: pairs, o: o.join(",") };
}

export function generateData(extraNames = []) {
  const names = [...new Set([...DEFAULT_PROPERTIES, ...extraNames])];
  return { version: 1, props: propertyTable(names), norm: normalizationTables() };
}

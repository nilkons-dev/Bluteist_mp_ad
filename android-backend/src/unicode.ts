/**
 * Runtime half of the Unicode compatibility layer (see scripts/android/unicode-compat.mjs).
 *
 * The Node embedded in Android is built without ICU, so three things are missing or broken:
 *   - regular expressions with property escapes:  /\p{L}/u, /\p{Script=Han}/u
 *   - String.prototype.normalize (a silent no-op)
 *   - TextDecoder for anything but utf-8 / utf-16le / latin1
 * Each is feature-detected and replaced only when absent, so on a full-ICU Node (desktop, tests) this does nothing.
 * Set BLUTHEIST_FORCE_UNICODE_SHIM=1 to force the replacements on (used by the tests).
 *
 * The data file (unicode-data.json) sits next to backend.js and is generated at build time.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface UnicodeData {
  props: Record<string, string>;
  norm: { d: Record<string, string>; k: Record<string, string>; c: Record<string, string>; o: string };
}

const FORCE = typeof process !== "undefined" && process.env?.BLUTHEIST_FORCE_UNICODE_SHIM === "1";
const MAX_CP = 0x10ffff;

let dataCache: UnicodeData | null = null;
function data(): UnicodeData {
  if (!dataCache) {
    // module.require is not analysed by the bundler, so the JSON stays a real file next to backend.js.
    const req: (id: string) => any = typeof module !== "undefined" && (module as any).require ? (module as any).require.bind(module) : require;
    dataCache = req("./unicode-data.json") as UnicodeData;
  }
  return dataCache;
}

/* ------------------------------------------------------------------ property escapes in RegExp */

const rangeCache = new Map<string, number[]>();

/** Flat sorted [lo, hi, lo, hi, ...] for a property, or null if the name is unknown. */
function propertyRanges(name: string): number[] | null {
  const cached = rangeCache.get(name);
  if (cached) return cached;
  const props = data().props;
  let text = props[name];
  if (text === undefined) {
    // \p{General_Category=Letter} and \p{gc=L} are the same as \p{Letter} / \p{L}.
    const eq = name.indexOf("=");
    if (eq > 0 && /^(General_Category|gc)$/.test(name.slice(0, eq))) text = props[name.slice(eq + 1)];
  }
  if (text === undefined) return null;
  const flat: number[] = [];
  if (text.length) {
    for (const part of text.split(",")) {
      const dash = part.indexOf("-");
      if (dash < 0) {
        const v = parseInt(part, 16);
        flat.push(v, v);
      } else {
        flat.push(parseInt(part.slice(0, dash), 16), parseInt(part.slice(dash + 1), 16));
      }
    }
  }
  rangeCache.set(name, flat);
  return flat;
}

function complement(flat: number[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] > next) out.push(next, flat[i] - 1);
    next = flat[i + 1] + 1;
  }
  if (next <= MAX_CP) out.push(next, MAX_CP);
  return out;
}

const cp = (n: number): string => `\\u{${n.toString(16)}}`;

function classBody(flat: number[]): string {
  let s = "";
  for (let i = 0; i < flat.length; i += 2) s += flat[i] === flat[i + 1] ? cp(flat[i]) : `${cp(flat[i])}-${cp(flat[i + 1])}`;
  return s;
}

const expandCache = new Map<string, string>();

/** Replaces \p{X} / \P{X} in a /u pattern by explicit code-point ranges (inside a class: bare; outside: a class). */
export function expandPropertyEscapes(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const n = pattern[i + 1];
      if ((n === "p" || n === "P") && pattern[i + 2] === "{") {
        const end = pattern.indexOf("}", i + 3);
        if (end > 0) {
          const name = pattern.slice(i + 3, end);
          const ranges = propertyRanges(name);
          if (!ranges) throw new SyntaxError(`Invalid regular expression: /${pattern}/: Invalid property name`);
          const body = classBody(n === "P" ? complement(ranges) : ranges);
          out += inClass ? body : `[${body}]`;
          i = end;
          continue;
        }
      }
      out += ch + (n ?? "");
      i++;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return out;
}

function hasPropertyEscape(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "\\") continue;
    const n = src[i + 1];
    if ((n === "p" || n === "P") && src[i + 2] === "{") return true;
    i++;
  }
  return false;
}

function installRegExp(): void {
  let supported = false;
  try {
    new RegExp("\\p{L}", "u");
    supported = true;
  } catch {
    supported = false;
  }
  if (supported && !FORCE) return;

  const Native = RegExp;
  const Wrapped = function RegExp(this: unknown, pattern?: unknown, flags?: unknown): RegExp {
    const isRe = pattern instanceof Native;
    if (!new.target && isRe && flags === undefined && (pattern as any).constructor === Wrapped) return pattern as RegExp;
    let src = isRe ? (pattern as RegExp).source : pattern === undefined ? "" : String(pattern);
    const fl = flags === undefined ? (isRe ? (pattern as RegExp).flags : "") : String(flags);
    if (fl.includes("u") && !fl.includes("v") && src.includes("\\") && hasPropertyEscape(src)) {
      const key = `${fl}/${src}`;
      let expanded = expandCache.get(key);
      if (expanded === undefined) {
        expanded = expandPropertyEscapes(src);
        if (expandCache.size > 500) expandCache.clear();
        expandCache.set(key, expanded);
      }
      src = expanded;
    }
    return Reflect.construct(Native, [src, fl], new.target ?? Wrapped) as RegExp;
  } as unknown as RegExpConstructor;

  Object.defineProperty(Wrapped, "prototype", { value: Native.prototype, writable: false });
  Object.setPrototypeOf(Wrapped, Native);
  Object.defineProperty(Wrapped, Symbol.species, { get: () => Wrapped, configurable: true });
  // $1…$9, lastMatch, input, … live on the native constructor; mirror them.
  for (const key of Object.getOwnPropertyNames(Native)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    try {
      Object.defineProperty(Wrapped, key, {
        get: () => (Native as any)[key],
        set: (v) => {
          (Native as any)[key] = v;
        },
        configurable: true,
      });
    } catch {
      /* non-configurable: skip */
    }
  }
  Object.defineProperty(Native.prototype, "constructor", { value: Wrapped, writable: true, configurable: true });
  (globalThis as any).RegExp = Wrapped;
}

/* ------------------------------------------------------------------ String.prototype.normalize */

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

interface NormTables {
  d: Map<number, number[]>;
  k: Map<number, number[]>;
  pairs: Map<number, number>;
  /** canonical combining class rank (1…n, ordered like the real classes); absent = starter (class 0) */
  ccc: Map<number, number>;
}
let normTables: NormTables | null = null;

function tables(): NormTables {
  if (normTables) return normTables;
  const { d, k, c, o } = data().norm;
  const toCps = (s: string): number[] => s.split(" ").map((h) => parseInt(h, 16));
  const dm = new Map<number, number[]>();
  const km = new Map<number, number[]>();
  const pm = new Map<number, number>();
  for (const key of Object.keys(d)) dm.set(parseInt(key, 16), toCps(d[key]));
  for (const key of Object.keys(k)) km.set(parseInt(key, 16), toCps(k[key]));
  for (const key of Object.keys(c)) {
    const [a, b] = toCps(key);
    pm.set(a * 0x200000 + b, parseInt(c[key], 16));
  }
  const cm = new Map<number, number>();
  if (o) {
    for (const item of o.split(",")) {
      const colon = item.indexOf(":");
      cm.set(parseInt(item.slice(0, colon), 16), parseInt(item.slice(colon + 1), 10));
    }
  }
  normTables = { d: dm, k: km, pairs: pm, ccc: cm };
  return normTables;
}

function decompose(input: string, compat: boolean): number[] {
  const t = tables();
  const out: number[] = [];
  for (const ch of input) {
    const c = ch.codePointAt(0)!;
    const s = c - S_BASE;
    if (s >= 0 && s < S_COUNT) {
      out.push(L_BASE + Math.floor(s / N_COUNT), V_BASE + Math.floor((s % N_COUNT) / T_COUNT));
      const tIndex = s % T_COUNT;
      if (tIndex) out.push(T_BASE + tIndex);
      continue;
    }
    const m = (compat ? t.k.get(c) : undefined) ?? t.d.get(c);
    if (m) for (const x of m) out.push(x);
    else out.push(c);
  }
  // Canonical ordering: inside every run of combining marks, stable-sort by combining class.
  const ccc = t.ccc;
  for (let i = 0; i < out.length; i++) {
    if (!ccc.has(out[i])) continue;
    let j = i;
    while (j < out.length && ccc.has(out[j])) j++;
    if (j - i > 1) {
      const run = out.slice(i, j).map((v, idx) => ({ v, idx, r: ccc.get(v)! }));
      run.sort((a, b) => a.r - b.r || a.idx - b.idx);
      for (let x = 0; x < run.length; x++) out[i + x] = run[x].v;
    }
    i = j - 1;
  }
  return out;
}

/** UAX #15 composition, with the reference algorithm's blocking rule. */
function compose(cps: number[]): number[] {
  const t = tables();
  if (cps.length === 0) return cps;
  const out: number[] = [cps[0]];
  let starter = t.ccc.has(cps[0]) ? -1 : 0;
  let lastClass = starter === 0 ? 0 : 256;
  for (let i = 1; i < cps.length; i++) {
    const c = cps[i];
    const cls = t.ccc.get(c) ?? 0;
    if (starter >= 0) {
      const s = out[starter];
      let composite: number | undefined;
      if (lastClass === 0 && starter === out.length - 1) {
        // Hangul: L + V → LV, LV + T → LVT
        if (s >= L_BASE && s < L_BASE + L_COUNT && c >= V_BASE && c < V_BASE + V_COUNT) {
          composite = S_BASE + ((s - L_BASE) * V_COUNT + (c - V_BASE)) * T_COUNT;
        } else if (s >= S_BASE && s < S_BASE + S_COUNT && (s - S_BASE) % T_COUNT === 0 && c > T_BASE && c < T_BASE + T_COUNT) {
          composite = s + (c - T_BASE);
        }
      }
      if (composite === undefined && (lastClass < cls || lastClass === 0)) composite = t.pairs.get(s * 0x200000 + c);
      if (composite !== undefined) {
        out[starter] = composite;
        continue;
      }
    }
    if (cls === 0) starter = out.length;
    lastClass = cls;
    out.push(c);
  }
  return out;
}

const FORMS = new Set(["NFC", "NFD", "NFKC", "NFKD"]);

function fromCps(cps: number[]): string {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < cps.length; i += CHUNK) s += String.fromCodePoint(...cps.slice(i, i + CHUNK));
  return s;
}

export function normalizeString(input: string, form: string): string {
  if (!FORMS.has(form)) throw new RangeError("The normalization form should be one of NFC, NFD, NFKC, NFKD.");
  // ASCII needs nothing; it is by far the most common input.
  if (!/[^\u0000-\u007f]/.test(input)) return input;
  const compat = form === "NFKC" || form === "NFKD";
  const dec = decompose(input, compat);
  return fromCps(form === "NFC" || form === "NFKC" ? compose(dec) : dec);
}

function installNormalize(): void {
  let works = false;
  try {
    works = "\u00e9".normalize("NFD").length === 2;
  } catch {
    works = false;
  }
  if (works && !FORCE) return;
  Object.defineProperty(String.prototype, "normalize", {
    value: function normalize(this: unknown, form: unknown = "NFC"): string {
      if (this === null || this === undefined) throw new TypeError("String.prototype.normalize called on null or undefined");
      return normalizeString(String(this), String(form));
    },
    writable: true,
    configurable: true,
  });
}

/* ------------------------------------------------------------------ TextDecoder labels */

function installTextDecoder(): void {
  const Native = (globalThis as any).TextDecoder;
  if (typeof Native !== "function") return;
  let needs = false;
  try {
    new Native("windows-1252");
  } catch {
    needs = true;
  }
  if (!needs) return;
  const LATIN1 = new Set(["windows-1252", "cp1252", "x-cp1252", "iso-8859-1", "iso8859-1", "latin1", "l1", "us-ascii", "ascii"]);
  const map = (label: unknown): unknown => {
    const l = String(label ?? "utf-8").trim().toLowerCase();
    if (LATIN1.has(l)) return "latin1";
    if (l === "utf-16" || l === "utf16" || l === "ucs-2") return "utf-16le";
    return label;
  };
  class TextDecoderCompat extends Native {
    constructor(label?: unknown, options?: unknown) {
      super(map(label), options);
    }
  }
  (globalThis as any).TextDecoder = TextDecoderCompat;
}

export function installUnicodeCompat(): void {
  installRegExp();
  installNormalize();
  installTextDecoder();
}

installUnicodeCompat();

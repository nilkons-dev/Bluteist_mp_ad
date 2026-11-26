/**
 * A small `Intl` for runtimes built without ICU (the Node embedded in Android has no `Intl` object at all, so even
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` throws a ReferenceError). Only installed when `Intl` is
 * missing; English-only, which is what the backend needs (it formats nothing the user sees — that happens in the
 * page, which has the real Intl).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const LOCALE = "en-US";

function canonical(l: unknown): string[] {
  if (l === undefined || l === null) return [];
  const list = Array.isArray(l) ? l : [l];
  return list.map((x) => String(x).replace(/_/g, "-")).filter((x) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(x));
}
const supportedLocalesOf = (l: unknown): string[] => canonical(l);

/* ---- DateTimeFormat ---- */
class DateTimeFormat {
  private opts: Record<string, unknown>;
  constructor(_locales?: unknown, options?: Record<string, unknown>) {
    this.opts = { ...(options ?? {}) };
  }
  static supportedLocalesOf = supportedLocalesOf;
  resolvedOptions(): Record<string, unknown> {
    return {
      locale: LOCALE,
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: (this.opts.timeZone as string) || "UTC",
      ...this.opts,
    };
  }
  format(date?: Date | number): string {
    const d = date === undefined ? new Date() : new Date(date);
    if (Number.isNaN(d.getTime())) throw new RangeError("Invalid time value");
    const o = this.opts;
    const hasTime = o.timeStyle || o.hour || o.minute || o.second;
    const hasDate = o.dateStyle || o.year || o.month || o.day || o.weekday || (!hasTime && true);
    if (hasDate && hasTime) return d.toLocaleString();
    if (hasTime) return d.toLocaleTimeString();
    return d.toLocaleDateString();
  }
  formatToParts(date?: Date | number): Array<{ type: string; value: string }> {
    return [{ type: "literal", value: this.format(date) }];
  }
}

/* ---- NumberFormat ---- */
class NumberFormat {
  private o: Record<string, any>;
  constructor(_locales?: unknown, options?: Record<string, unknown>) {
    this.o = { ...(options ?? {}) };
  }
  static supportedLocalesOf = supportedLocalesOf;
  resolvedOptions(): Record<string, unknown> {
    return { locale: LOCALE, numberingSystem: "latn", style: this.o.style ?? "decimal", ...this.o };
  }
  format(value: number | bigint): string {
    let n = Number(value);
    if (Number.isNaN(n)) return "NaN";
    if (!Number.isFinite(n)) return n < 0 ? "-∞" : "∞";
    const o = this.o;
    if (o.style === "percent") n *= 100;
    let suffix = "";
    if (o.notation === "compact") {
      const abs = Math.abs(n);
      const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
      for (const [size, s] of units) {
        if (abs >= size) {
          n /= size;
          suffix = s;
          break;
        }
      }
    }
    const isCurrency = o.style === "currency";
    const minF = o.minimumFractionDigits ?? (isCurrency ? 2 : 0);
    const maxF = Math.max(minF, o.maximumFractionDigits ?? (isCurrency ? 2 : o.style === "percent" ? 0 : suffix ? 1 : 3));
    let s = Math.abs(n).toFixed(maxF);
    if (s.includes(".")) {
      let [int, frac] = s.split(".");
      while (frac.length > minF && frac.endsWith("0")) frac = frac.slice(0, -1);
      s = frac.length ? `${int}.${frac}` : int;
    }
    if (o.useGrouping !== false) {
      const [int, frac] = s.split(".");
      s = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
    }
    if (o.minimumIntegerDigits) s = s.padStart(o.minimumIntegerDigits, "0");
    s += suffix;
    if (o.style === "percent") s += "%";
    if (isCurrency) {
      const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", BDT: "৳" };
      s = (symbols[String(o.currency).toUpperCase()] ?? `${String(o.currency).toUpperCase()} `) + s;
    }
    return (n < 0 && Number(s.replace(/[^\d.]/g, "")) !== 0 ? "-" : "") + s;
  }
  formatToParts(value: number): Array<{ type: string; value: string }> {
    return [{ type: "literal", value: this.format(value) }];
  }
}

/* ---- Collator ---- */
const stripMarks = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
class Collator {
  private o: Record<string, any>;
  constructor(_locales?: unknown, options?: Record<string, unknown>) {
    this.o = { ...(options ?? {}) };
    this.compare = this.compare.bind(this);
  }
  static supportedLocalesOf = supportedLocalesOf;
  resolvedOptions(): Record<string, unknown> {
    return { locale: LOCALE, usage: "sort", sensitivity: "variant", ignorePunctuation: false, collation: "default", numeric: false, caseFirst: "false", ...this.o };
  }
  compare(a: string, b: string): number {
    let x = String(a);
    let y = String(b);
    const sens = this.o.sensitivity;
    if (sens === "base" || sens === "accent") {
      x = x.toLowerCase();
      y = y.toLowerCase();
    }
    if (sens === "base") {
      x = stripMarks(x);
      y = stripMarks(y);
    }
    if (this.o.numeric) {
      const parts = (s: string): string[] => s.match(/\d+|\D+/g) ?? [];
      const pa = parts(x);
      const pb = parts(y);
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        const na = /^\d/.test(pa[i]);
        const nb = /^\d/.test(pb[i]);
        if (na && nb) {
          const d = Number(pa[i]) - Number(pb[i]);
          if (d) return d < 0 ? -1 : 1;
        } else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
      }
      return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
    }
    return x === y ? 0 : x < y ? -1 : 1;
  }
}

/* ---- PluralRules ---- */
class PluralRules {
  private type: string;
  constructor(_locales?: unknown, options?: { type?: string }) {
    this.type = options?.type ?? "cardinal";
  }
  static supportedLocalesOf = supportedLocalesOf;
  resolvedOptions(): Record<string, unknown> {
    return { locale: LOCALE, type: this.type };
  }
  select(n: number): string {
    if (this.type === "ordinal") {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return "one";
      if (m10 === 2 && m100 !== 12) return "two";
      if (m10 === 3 && m100 !== 13) return "few";
      return "other";
    }
    return n === 1 ? "one" : "other";
  }
}

/* ---- ListFormat ---- */
class ListFormat {
  private o: { type?: string; style?: string };
  constructor(_locales?: unknown, options?: { type?: string; style?: string }) {
    this.o = options ?? {};
  }
  static supportedLocalesOf = supportedLocalesOf;
  format(list: Iterable<string>): string {
    const a = [...list].map(String);
    const word = this.o.type === "disjunction" ? "or" : this.o.type === "unit" ? "" : "and";
    if (a.length <= 1) return a.join("");
    if (!word) return a.join(this.o.style === "narrow" ? " " : ", ");
    if (a.length === 2) return `${a[0]} ${word} ${a[1]}`;
    return `${a.slice(0, -1).join(", ")}, ${word} ${a[a.length - 1]}`;
  }
}

/* ---- RelativeTimeFormat ---- */
class RelativeTimeFormat {
  private o: { numeric?: string };
  constructor(_locales?: unknown, options?: { numeric?: string }) {
    this.o = options ?? {};
  }
  static supportedLocalesOf = supportedLocalesOf;
  format(value: number, unit: string): string {
    const u = String(unit).replace(/s$/, "");
    const n = Math.abs(value);
    if (this.o.numeric === "auto" && n <= 1) {
      if (u === "day") return value === 0 ? "today" : value > 0 ? "tomorrow" : "yesterday";
      if (value === 0) return `this ${u}`;
      return `${value > 0 ? "next" : "last"} ${u}`;
    }
    const label = `${n} ${u}${n === 1 ? "" : "s"}`;
    return value < 0 || Object.is(value, -0) ? `${label} ago` : `in ${label}`;
  }
}

/* ---- Segmenter ---- */
class Segmenter {
  private gran: string;
  constructor(_locales?: unknown, options?: { granularity?: string }) {
    this.gran = options?.granularity ?? "grapheme";
  }
  static supportedLocalesOf = supportedLocalesOf;
  resolvedOptions(): Record<string, unknown> {
    return { locale: LOCALE, granularity: this.gran };
  }
  segment(input: string): Iterable<{ segment: string; index: number; input: string; isWordLike?: boolean }> {
    const str = String(input);
    const gran = this.gran;
    const out: Array<{ segment: string; index: number; input: string; isWordLike?: boolean }> = [];
    if (gran === "grapheme") {
      // code point + following combining marks / variation selectors / ZWJ-joined parts / skin-tone modifiers
      const re = /(?:\r\n|[\s\S])(?:[\u0300-\u036f\u200d\ufe0f\u20d0-\u20ff]|[\u{1f3fb}-\u{1f3ff}]|(?<=\u200d)[\s\S])*/gu;
      for (const m of str.matchAll(re)) out.push({ segment: m[0], index: m.index ?? 0, input: str });
    } else if (gran === "word") {
      const re = /[\p{L}\p{M}\p{N}_']+|\s+|[\s\S]/gu;
      for (const m of str.matchAll(re)) out.push({ segment: m[0], index: m.index ?? 0, input: str, isWordLike: /[\p{L}\p{N}]/u.test(m[0]) });
    } else {
      const re = /[^.!?。！？]+[.!?。！？]*\s*|[.!?。！？]+\s*/g;
      for (const m of str.matchAll(re)) out.push({ segment: m[0], index: m.index ?? 0, input: str });
    }
    return out;
  }
}

/* ---- DisplayNames / Locale ---- */
class DisplayNames {
  constructor(_locales?: unknown, _options?: unknown) {}
  static supportedLocalesOf = supportedLocalesOf;
  of(code: string): string {
    return String(code);
  }
  resolvedOptions(): Record<string, unknown> {
    return { locale: LOCALE };
  }
}
class Locale {
  readonly baseName: string;
  readonly language: string;
  readonly region?: string;
  readonly script?: string;
  constructor(tag: string) {
    const parts = String(tag).replace(/_/g, "-").split("-");
    this.language = (parts[0] ?? "en").toLowerCase();
    for (const p of parts.slice(1)) {
      if (/^[A-Za-z]{4}$/.test(p)) this.script = p[0].toUpperCase() + p.slice(1).toLowerCase();
      else if (/^[A-Za-z]{2}$|^\d{3}$/.test(p)) this.region = p.toUpperCase();
    }
    this.baseName = [this.language, this.script, this.region].filter(Boolean).join("-");
  }
  toString(): string {
    return this.baseName;
  }
}

/** DateTimeFormat, NumberFormat and Collator are callable without `new` in real Intl (`Intl.DateTimeFormat()`). */
function callable<T extends new (...args: any[]) => any>(Cls: T): T {
  return new Proxy(Cls, { apply: (target, _this, args) => new target(...args) });
}

if (typeof g.Intl === "undefined") {
  const Intl = {
    DateTimeFormat: callable(DateTimeFormat),
    NumberFormat: callable(NumberFormat),
    Collator: callable(Collator),
    PluralRules,
    ListFormat,
    RelativeTimeFormat,
    Segmenter,
    DisplayNames,
    Locale,
    getCanonicalLocales: canonical,
    supportedValuesOf: (): string[] => [],
  };
  Object.defineProperty(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
  Object.defineProperty(g, "Intl", { value: Intl, writable: true, configurable: true });
}

export {};

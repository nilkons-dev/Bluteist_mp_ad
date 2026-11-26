/**
 * Fills in the JavaScript/Node APIs that the embedded Node.js (nodejs-mobile, usually Node 18) lacks but the
 * bundled libraries (youtubei.js, music-metadata, undici, ...) may touch. Imported FIRST by main.ts, so it
 * runs before any of them is evaluated. Every shim is feature-detected: on a newer Node it does nothing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

function define(target: any, name: string, value: unknown): void {
  if (target[name] !== undefined) return;
  try {
    Object.defineProperty(target, name, { value, writable: true, configurable: true });
  } catch {
    /* frozen intrinsic: nothing to do */
  }
}

// Web Crypto as a global (Node < 20 only has it under require("crypto").webcrypto).
if (!g.crypto) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    g.crypto = require("crypto").webcrypto;
  } catch {
    /* no webcrypto build */
  }
}
if (!g.File) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    g.File = require("buffer").File;
  } catch {
    /* older Node: File is not needed unless a library constructs one */
  }
}
if (typeof g.structuredClone !== "function") {
  g.structuredClone = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
}
if (typeof g.CustomEvent !== "function" && typeof g.Event === "function") {
  g.CustomEvent = class CustomEvent<T = unknown> extends g.Event {
    detail: T | null;
    constructor(type: string, init?: { detail?: T }) {
      super(type);
      this.detail = init?.detail ?? null;
    }
  };
}

// ES2023–2024 additions.
define(Promise, "withResolvers", function <T>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
});
define(Array.prototype, "toSorted", function (this: unknown[], cmp?: (a: unknown, b: unknown) => number) {
  return [...this].sort(cmp);
});
define(Array.prototype, "toReversed", function (this: unknown[]) {
  return [...this].reverse();
});
define(Array.prototype, "toSpliced", function (this: unknown[], ...args: [number, number?, ...unknown[]]) {
  const copy = [...this];
  (copy.splice as (...a: unknown[]) => unknown[])(...args);
  return copy;
});
define(Array.prototype, "with", function (this: unknown[], index: number, value: unknown) {
  const copy = [...this];
  const i = index < 0 ? copy.length + index : index;
  if (i < 0 || i >= copy.length) throw new RangeError("Invalid index");
  copy[i] = value;
  return copy;
});
define(Array, "fromAsync", async function (iterable: AsyncIterable<unknown> | Iterable<unknown>) {
  const out: unknown[] = [];
  for await (const v of iterable as AsyncIterable<unknown>) out.push(v);
  return out;
});
define(Object, "groupBy", function (items: Iterable<unknown>, key: (v: unknown, i: number) => PropertyKey) {
  const out: Record<PropertyKey, unknown[]> = Object.create(null);
  let i = 0;
  for (const v of items) (out[key(v, i++)] ??= []).push(v);
  return out;
});
define(Map, "groupBy", function (items: Iterable<unknown>, key: (v: unknown, i: number) => unknown) {
  const out = new Map<unknown, unknown[]>();
  let i = 0;
  for (const v of items) {
    const k = key(v, i++);
    const list = out.get(k);
    if (list) list.push(v);
    else out.set(k, [v]);
  }
  return out;
});
define(String.prototype, "isWellFormed", function (this: string) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(this);
});
define(String.prototype, "toWellFormed", function (this: string) {
  return this.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
});
if (typeof g.AbortSignal?.any !== "function" && g.AbortSignal) {
  g.AbortSignal.any = (signals: Array<{ aborted: boolean; reason?: unknown; addEventListener: (t: string, f: () => void, o?: unknown) => void }>) => {
    const ctl = new AbortController();
    for (const s of signals) {
      if (s.aborted) {
        ctl.abort(s.reason);
        break;
      }
      s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
    }
    return ctl.signal;
  };
}
if (typeof (URL as any).canParse !== "function") {
  (URL as any).canParse = (u: string, base?: string) => {
    try {
      new URL(u, base);
      return true;
    } catch {
      return false;
    }
  };
}

export {};

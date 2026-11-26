/**
 * Client for the embedded Node.js backend (capacitor-nodejs). Speaks android-backend/src/protocol.ts.
 */
import { NodeJS } from "capacitor-nodejs";
import { MSG_EVENT, type HostOp, type InitInfo, type ToBackend, type ToWebView } from "../../android-backend/src/protocol";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const pending = new Map<number, Pending>();
const eventSubs = new Map<string, Set<(payload: any) => void>>();
let nextId = 1;
let hostHandler: (op: HostOp, args: unknown[]) => Promise<unknown> = () => Promise.reject(new Error("No host handler"));

let readyResolve!: () => void;
let readyReject!: (e: Error) => void;
let isReady = false;
let failure: string | null = null;
const readyPromise = new Promise<void>((res, rej) => {
  readyResolve = res;
  readyReject = rej;
});
readyPromise.catch(() => undefined); // surfaced by whoever awaits it

const statusSubs = new Set<(s: { phase: "starting" | "ready" | "failed"; message?: string }) => void>();
const announce = (s: { phase: "starting" | "ready" | "failed"; message?: string }): void => statusSubs.forEach((f) => f(s));
export function onStatus(cb: (s: { phase: "starting" | "ready" | "failed"; message?: string }) => void): () => void {
  statusSubs.add(cb);
  return () => statusSubs.delete(cb);
}

/* ---- binary helpers ---- */
function toB64(u8: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function encode(msg: ToBackend): string {
  return JSON.stringify(msg, function (this: any, key: string, value: unknown) {
    const original = this?.[key];
    if (original instanceof Uint8Array) return { __bin: toB64(original) };
    if (original instanceof ArrayBuffer) return { __bin: toB64(new Uint8Array(original)) };
    return value;
  });
}
function decode(json: string): ToWebView | null {
  try {
    return JSON.parse(json, (_k, v) => (v && typeof v === "object" && typeof v.__bin === "string" ? fromB64(v.__bin) : v)) as ToWebView;
  } catch {
    return null;
  }
}

function post(msg: ToBackend): void {
  void NodeJS.send({ eventName: MSG_EVENT, args: [encode(msg)] }).catch(() => undefined);
}

function onMessage(json: string): void {
  const msg = decode(json);
  if (!msg) return;
  switch (msg.t) {
    case "ready":
      if (!isReady) {
        isReady = true;
        announce({ phase: "ready" });
        readyResolve();
      }
      break;
    case "fatal":
      failure = msg.message;
      announce({ phase: "failed", message: msg.message });
      readyReject(new Error(msg.message));
      break;
    case "res": {
      const p = pending.get(msg.id);
      if (!p) break;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || "Request failed"));
      break;
    }
    case "evt":
      eventSubs.get(msg.ev)?.forEach((cb) => {
        try {
          cb(msg.payload);
        } catch {
          /* a listener's bug must not stop the others */
        }
      });
      break;
    case "host":
      void hostHandler(msg.op, msg.args).then(
        (value) => post({ t: "hres", id: msg.id, ok: true, value }),
        (err) => post({ t: "hres", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      );
      break;
  }
}

function payloadString(ev: unknown): string | null {
  if (typeof ev === "string") return ev;
  const args = (ev as { args?: unknown[] } | null)?.args;
  return Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
}

let started = false;

/** Attach to the backend and give it its paths. Idempotent; the promise resolves when the backend says ready. */
export function connect(info: InitInfo, host: (op: HostOp, args: unknown[]) => Promise<unknown>): Promise<void> {
  hostHandler = host;
  if (started) return readyPromise;
  started = true;
  announce({ phase: "starting" });
  void (async () => {
    try {
      await NodeJS.addListener(MSG_EVENT, (ev: unknown) => {
        const s = payloadString(ev);
        if (s !== null) onMessage(s);
      });
      await NodeJS.whenReady();
      post({ t: "init", info });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      announce({ phase: "failed", message: failure });
      readyReject(new Error(failure));
    }
  })();
  return readyPromise;
}

/** Re-send init (after a WebView reload the backend is still running and answers `ready` again). */
export function reinit(info: InitInfo): void {
  if (started) post({ t: "init", info });
}

export const whenReady = (): Promise<void> => readyPromise;
export const failureMessage = (): string | null => failure;

export async function invoke<T = any>(ch: string, ...args: unknown[]): Promise<T> {
  await readyPromise;
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ t: "req", id, ch, args });
  });
}

export function send(ch: string, ...args: unknown[]): void {
  if (!isReady) return; // fire-and-forget events before the backend is up are simply dropped
  post({ t: "send", ch, args });
}

export function onEvent<T = any>(ev: string, cb: (payload: T) => void): () => void {
  let set = eventSubs.get(ev);
  if (!set) eventSubs.set(ev, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

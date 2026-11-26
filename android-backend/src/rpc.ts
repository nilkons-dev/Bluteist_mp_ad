/**
 * ipcMain-style dispatcher on top of an abstract text transport.
 * Handlers are registered by channel name exactly like electron/main.ts does (`ipc.handle` / `ipc.on`).
 */
import { binReplacer, binReviver, type HostOp, type ToBackend, type ToWebView } from "./protocol";
import { bindTransport, setInit } from "./host";

export interface Transport {
  send(json: string): void;
  onMessage(cb: (json: string) => void): void;
}

type Handler = (...args: any[]) => unknown;

const invokeHandlers = new Map<string, Handler>();
const sendHandlers = new Map<string, Handler>();
let transport: Transport | null = null;
let nextHostId = 1;
const pendingHost = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let onInit: (() => void | Promise<void>) | null = null;

/** Like ipcMain.handle: the returned value (or thrown error) goes back to the caller. */
export function handle(channel: string, fn: Handler): void {
  invokeHandlers.set(channel, fn);
}

/** Like ipcMain.on: fire-and-forget. */
export function on(channel: string, fn: Handler): void {
  sendHandlers.set(channel, fn);
}

function post(msg: ToWebView): void {
  if (!transport) return;
  let json: string;
  try {
    json = JSON.stringify(msg, binReplacer);
  } catch (err) {
    // A value that cannot be serialised (cycles, BigInt): answer with an error rather than silence.
    if (msg.t === "res") {
      json = JSON.stringify({ t: "res", id: msg.id, ok: false, error: `Reply could not be sent: ${err instanceof Error ? err.message : err}` });
    } else {
      return;
    }
  }
  transport.send(json);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "Unknown error";
}

async function onRequest(msg: Extract<ToBackend, { t: "req" }>): Promise<void> {
  const fn = invokeHandlers.get(msg.ch);
  if (!fn) {
    post({ t: "res", id: msg.id, ok: false, error: `No handler for ${msg.ch}` });
    return;
  }
  try {
    const value = await fn(...(Array.isArray(msg.args) ? msg.args : []));
    post({ t: "res", id: msg.id, ok: true, value: value === undefined ? null : value });
  } catch (err) {
    post({ t: "res", id: msg.id, ok: false, error: errorText(err) });
  }
}

function handleMessage(json: string): void {
  let msg: ToBackend;
  try {
    msg = JSON.parse(json, binReviver) as ToBackend;
  } catch {
    return;
  }
  switch (msg.t) {
    case "init":
      setInit(msg.info);
      if (onInit) {
        const run = onInit;
        onInit = null; // a second init (WebView reload) must not boot everything twice
        void Promise.resolve()
          .then(run)
          .catch((err) => post({ t: "fatal", message: errorText(err) }));
      } else {
        post({ t: "ready" });
      }
      break;
    case "req":
      void onRequest(msg);
      break;
    case "send": {
      const fn = sendHandlers.get(msg.ch);
      if (!fn) break;
      try {
        const out = fn(...(Array.isArray(msg.args) ? msg.args : []));
        if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(() => undefined);
      } catch {
        /* fire-and-forget: nothing to tell */
      }
      break;
    }
    case "hres": {
      const p = pendingHost.get(msg.id);
      if (!p) break;
      pendingHost.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || "The app shell refused"));
      break;
    }
  }
}

function hostCall(op: HostOp, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextHostId++;
    // A file chooser can legitimately stay open for minutes; anything else answers at once.
    const ms = op === "dialog.open" ? 10 * 60_000 : 30_000;
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`The app didn't answer (${op})`));
    }, ms);
    pendingHost.set(id, { resolve, reject, timer });
    post({ t: "host", id, op, args });
  });
}

/**
 * Wire the dispatcher to a transport. `boot` runs once, when the WebView's `init` arrives (paths are
 * unknown before that, and every module reads them lazily); it announces `ready` when it resolves.
 */
export function start(t: Transport, boot: () => void | Promise<void>): void {
  transport = t;
  bindTransport(
    (ev, payload) => post({ t: "evt", ev, payload }),
    (op, args) => hostCall(op, args)
  );
  onInit = async () => {
    await boot();
    post({ t: "ready" });
  };
  t.onMessage(handleMessage);
}

export function fatal(message: string): void {
  post({ t: "fatal", message });
}

/**
 * Process-wide state shared by the Electron shim and the RPC layer.
 * Dependency-free on purpose (only types), so it can be unit-tested under plain Node.
 */
import type { HostOp, InitInfo } from "./protocol";

let info: InitInfo | null = null;
let emitImpl: (ev: string, payload: unknown) => void = () => undefined;
let hostImpl: (op: HostOp, args: unknown[]) => Promise<unknown> = () => Promise.reject(new Error("The app shell isn't connected yet."));
const initWaiters: Array<() => void> = [];

export function setInit(i: InitInfo): void {
  info = i;
  for (const w of initWaiters.splice(0)) w();
}

/** The init info; throws if the WebView hasn't sent it yet (every module reads paths lazily, after init). */
export function init(): InitInfo {
  if (!info) throw new Error("Backend not initialised yet");
  return info;
}

export function isInitialised(): boolean {
  return info !== null;
}

export function whenInitialised(): Promise<void> {
  return info ? Promise.resolve() : new Promise((resolve) => initWaiters.push(resolve));
}

export function bindTransport(
  emit: (ev: string, payload: unknown) => void,
  host: (op: HostOp, args: unknown[]) => Promise<unknown>
): void {
  emitImpl = emit;
  hostImpl = host;
}

/** webContents.send(ev, payload) equivalent. Never throws. */
export function emit(ev: string, payload?: unknown): void {
  try {
    emitImpl(ev, payload ?? null);
  } catch {
    /* the WebView is gone; nothing to tell */
  }
}

/** Ask the native shell to do something (pick a file, open a link, ...). */
export function callHost<T = unknown>(op: HostOp, ...args: unknown[]): Promise<T> {
  return hostImpl(op, args) as Promise<T>;
}

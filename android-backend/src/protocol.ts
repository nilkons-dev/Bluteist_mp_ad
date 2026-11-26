/**
 * Wire protocol between the Android WebView (renderer) and the embedded Node.js backend.
 *
 * The Electron build talks over ipcRenderer/ipcMain. On Android the same channel names travel over
 * the nodejs-mobile message bridge as ONE event ("msg") carrying ONE JSON string, so nothing depends
 * on how the plugin serialises richer argument lists.
 *
 *   WebView → Node   init   {dataDir, ...}            once, right after the backend is reachable
 *                    req    {id, ch, args}            like ipcRenderer.invoke   → answered by `res`
 *                    send   {ch, args}                like ipcRenderer.send     → no answer
 *                    hres   {id, ok, value|error}     answer to a `host` call
 *   Node → WebView   ready  {}                        backend finished booting
 *                    res    {id, ok, value|error}     answer to `req`
 *                    evt    {ev, payload}             like webContents.send(ev, payload)
 *                    host   {id, op, args}            the backend asks the WebView to do something native
 *                                                     (pick a file, open a link, ...) → answered by `hres`
 *                    fatal  {message}                 the backend could not start
 *
 * Binary values (Uint8Array / Buffer) are carried as {"__bin": "<base64>"} in both directions.
 */

export const MSG_EVENT = "msg";

export interface InitInfo {
  /** App-private persistent directory (Android `filesDir`). Replaces Electron's userData. */
  dataDir: string;
  /** App cache directory. */
  cacheDir: string;
  /** Public Music directory, e.g. /storage/emulated/0/Music (null if unknown). */
  musicDir: string | null;
  /** Public Download directory, e.g. /storage/emulated/0/Download (null if unknown). */
  downloadDir: string | null;
  /** App-specific external directory (always writable without permissions), or null. */
  externalFilesDir: string | null;
  /** Root of shared storage, e.g. /storage/emulated/0 (null if unknown). */
  storageRoot: string | null;
  /** BCP-47 locale such as "en-US" or "bn-BD". */
  locale: string;
  /** Upper-case ISO region from the locale ("BD"), or "". */
  region: string;
  /** App version string (package.json). */
  version: string;
}

export type ToBackend =
  | { t: "init"; info: InitInfo }
  | { t: "req"; id: number; ch: string; args: unknown[] }
  | { t: "send"; ch: string; args: unknown[] }
  | { t: "hres"; id: number; ok: boolean; value?: unknown; error?: string };

export type ToWebView =
  | { t: "ready" }
  | { t: "res"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "evt"; ev: string; payload: unknown }
  | { t: "host"; id: number; op: HostOp; args: unknown[] }
  | { t: "fatal"; message: string };

/** Things only the WebView/native shell can do. */
export type HostOp =
  | "dialog.open" // args: [{title, filters, properties}] → {canceled, filePaths}
  | "shell.openExternal" // args: [url] → void
  | "shell.share" // args: [path, title?] → void
  | "notify"; // args: [{title, body}] → void

/** JSON.stringify replacer: Buffer/Uint8Array → {"__bin": base64}. Use with a *function* (needs `this`). */
export function binReplacer(this: any, key: string, value: unknown): unknown {
  const original = this?.[key];
  if (original instanceof Uint8Array) {
    return { __bin: (typeof Buffer !== "undefined" ? Buffer.from(original) : original).toString("base64") };
  }
  return value;
}

/** JSON.parse reviver: {"__bin": base64} → Buffer (Node) — the WebView side has its own decoder. */
export function binReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && typeof (value as { __bin?: unknown }).__bin === "string") {
    const b64 = (value as { __bin: string }).__bin;
    return typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : value;
  }
  return value;
}

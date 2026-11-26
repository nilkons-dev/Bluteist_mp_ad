/**
 * A tiny stand-in for the `electron` module.
 *
 * The Android bundle aliases `electron` to this file (scripts/android/build-backend.mjs), so the
 * existing modules in electron/ — music-service, ytm, lyrics, downloads, local-library, stats, sync,
 * persist, spotify, supabase, backup ... — run unchanged inside the embedded Node.js. Only the few
 * Electron APIs those modules actually touch are provided; everything window/menu/tray related is
 * absent because Android has none of it.
 */
import * as fs from "fs";
import * as path from "path";
import { callHost, init, isInitialised } from "./host";

/* ------------------------------------------------------------------ app */

const exitHandlers: Array<() => void> = [];

function dirOrFallback(primary: string | null | undefined, fallback: string): string {
  return primary && primary.length > 0 ? primary : fallback;
}

export const app = {
  name: "Blutheist",
  /** There is no dev build of the Android backend. */
  isPackaged: true,
  getVersion: (): string => (isInitialised() ? init().version : "0.0.0"),
  getLocale: (): string => (isInitialised() ? init().locale || "en-US" : "en-US"),
  getLocaleCountryCode: (): string => (isInitialised() ? init().region || "" : ""),
  getAppPath: (): string => path.join(init().dataDir, "app"),
  /**
   * Where things live on Android:
   *  userData / appData / home / documents → the app-private files dir (always writable, backed up by nothing)
   *  downloads → app-specific external dir (needs no permission; removed with the app)
   *  music     → the public Music folder, so exported/"compatible" downloads show up in other players
   *  temp / cache → the cache dir
   */
  getPath: (name: string): string => {
    const i = init();
    switch (name) {
      case "userData":
        return path.join(i.dataDir, "blutheist");
      case "appData":
        return path.join(i.dataDir, "appdata");
      case "temp":
      case "cache":
      case "logs":
        return i.cacheDir;
      case "downloads":
        return dirOrFallback(i.externalFilesDir, path.join(i.dataDir, "downloads"));
      case "music":
        return dirOrFallback(i.musicDir, dirOrFallback(i.externalFilesDir, path.join(i.dataDir, "music")));
      case "documents":
      case "home":
      case "desktop":
      case "exe":
      case "module":
        return i.dataDir;
      default:
        return i.dataDir;
    }
  },
  whenReady: (): Promise<void> => Promise.resolve(),
  requestSingleInstanceLock: (): boolean => true,
  setAsDefaultProtocolClient: (): boolean => true,
  setAppUserModelId: (): void => undefined,
  commandLine: { appendSwitch: (): void => undefined },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, listener: () => void): any => {
    if (event === "before-quit") exitHandlers.push(listener);
    return app;
  },
  quit: (): void => {
    for (const h of exitHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  },
  exit: (code = 0): void => process.exit(code),
};

/* ------------------------------------------------------------------ ipcMain (registry only) */

type Listener = (event: { sender: unknown }, ...args: any[]) => unknown;
const handlers = new Map<string, Listener>();
const listeners = new Map<string, Listener[]>();

export const ipcMain = {
  handle: (channel: string, fn: Listener): void => {
    handlers.set(channel, fn);
  },
  removeHandler: (channel: string): void => {
    handlers.delete(channel);
  },
  on: (channel: string, fn: Listener): void => {
    const list = listeners.get(channel) ?? [];
    list.push(fn);
    listeners.set(channel, list);
  },
};

/* ------------------------------------------------------------------ windows (none on Android) */

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  webContents = { session: {}, send: (): void => undefined };
  isDestroyed(): boolean {
    return true;
  }
  close(): void {
    /* no windows */
  }
}

export type NativeImage = unknown;
export type IpcMainInvokeEvent = { sender: unknown };
export type IpcMainEvent = { sender: unknown };

/* ------------------------------------------------------------------ session (spotify's partition) */

const sessionStub = {
  clearStorageData: (): Promise<void> => Promise.resolve(),
  webRequest: { onBeforeSendHeaders: (): void => undefined, onCompleted: (): void => undefined },
  cookies: { get: (): Promise<unknown[]> => Promise.resolve([]), remove: (): Promise<void> => Promise.resolve() },
  setPermissionRequestHandler: (): void => undefined,
  setPermissionCheckHandler: (): void => undefined,
};
export const session = {
  defaultSession: sessionStub,
  fromPartition: (_name: string): typeof sessionStub => sessionStub,
};

/* ------------------------------------------------------------------ safeStorage */

/**
 * Android's app-private storage is already sandboxed per app, so secrets are stored with secrets.ts's
 * "plain:" prefix (its documented fallback when no OS encryption exists).
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, "utf-8"),
  decryptString: (b: Buffer): string => b.toString("utf-8"),
};

/* ------------------------------------------------------------------ shell */

export const shell = {
  openExternal: async (url: string): Promise<void> => {
    await callHost("shell.openExternal", String(url));
  },
  openPath: async (p: string): Promise<string> => {
    try {
      await callHost("shell.share", String(p));
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : "Couldn't open that";
    }
  },
  showItemInFolder: (): void => undefined,
};

/* ------------------------------------------------------------------ Notification */

export class Notification {
  static isSupported(): boolean {
    return false;
  }
  constructor(_opts?: unknown) {
    /* unsupported */
  }
  on(): this {
    return this;
  }
  show(): void {
    /* unsupported */
  }
}

/* ------------------------------------------------------------------ powerMonitor */

export const powerMonitor = { on: (): void => undefined };

/* ------------------------------------------------------------------ dialog */

interface OpenOpts {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: string[];
}
interface SaveOpts {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Electron's overloads take an optional parent window first; Android has none, so it's skipped. */
function pickOpts<T>(a: unknown, b: unknown): T {
  return ((b !== undefined ? b : a) ?? {}) as T;
}

export const dialog = {
  /** "Open file": the WebView shows the system file chooser and hands the bytes over as a temp file. */
  showOpenDialog: async (a: unknown, b?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> => {
    const opts = pickOpts<OpenOpts>(a, b);
    const res = await callHost<{ canceled?: boolean; filePaths?: string[] }>("dialog.open", {
      title: opts.title ?? "",
      filters: opts.filters ?? [],
      properties: opts.properties ?? [],
    });
    const filePaths = Array.isArray(res?.filePaths) ? res.filePaths.filter((p) => typeof p === "string") : [];
    return { canceled: !!res?.canceled || filePaths.length === 0, filePaths };
  },
  /**
   * "Save file": there is no save panel on Android. The file goes to the cache's exports folder and the
   * renderer-side bridge then opens the share sheet for it (Save to Drive / Files / send to a friend).
   */
  showSaveDialog: async (a: unknown, b?: unknown): Promise<{ canceled: boolean; filePath?: string }> => {
    const opts = pickOpts<SaveOpts>(a, b);
    const dir = path.join(init().cacheDir, "exports");
    await fs.promises.mkdir(dir, { recursive: true });
    const base = path.basename(opts.defaultPath || "blutheist-export");
    return { canceled: false, filePath: path.join(dir, base) };
  },
};

/* ------------------------------------------------------------------ misc stubs some modules import by name */

export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }), getAllDisplays: () => [] };
export const protocol = { handle: (): void => undefined, registerSchemesAsPrivileged: (): void => undefined };
export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }) };
export const clipboard = { write: async (): Promise<void> => undefined };
export class Tray {}
export const Menu = { setApplicationMenu: (): void => undefined, buildFromTemplate: () => ({}) };

export default { app, ipcMain, BrowserWindow, session, safeStorage, shell, Notification, powerMonitor, dialog };

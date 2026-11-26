/**
 * `window.bytune` for Android.
 *
 * The renderer was written against the Electron preload (electron/preload.ts). This object has the same
 * shape: data/music/library/download/room/auth/sync calls travel to the embedded Node backend
 * (android-backend/src/main.ts) under their Electron channel names; window-chrome, miniplayer (PiP),
 * macOS menu, Discord and Windows-flyout calls have no Android meaning and resolve harmlessly here.
 */
import { registerPlugin } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { BlutheistApi } from "../../electron/preload";
import type { HostOp, InitInfo } from "../../android-backend/src/protocol";
import { version as appVersion } from "../../package.json";
import { connect, invoke, onEvent, send } from "./nodeLink";
import { showFolderBrowser } from "./FolderBrowser";

/* ------------------------------------------------------------------ native helper plugin (Java, see scripts/android/native) */

interface NativePlugin {
  audioPermission(): Promise<{ granted: boolean }>;
  requestAudioPermission(): Promise<{ granted: boolean }>;
  requestNotifications(): Promise<{ granted: boolean }>;
}
const Native = registerPlugin<NativePlugin>("BlutheistNative");

let audioPermOk = false;
async function ensureAudioPermission(): Promise<boolean> {
  if (audioPermOk) return true;
  try {
    const cur = await Native.audioPermission();
    audioPermOk = cur.granted || (await Native.requestAudioPermission()).granted;
  } catch {
    audioPermOk = true; // plugin missing (a dev build): let the filesystem say what it says
  }
  return audioPermOk;
}

/* ------------------------------------------------------------------ paths handed to the backend */

const stripFile = (uri: string): string => decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/\/+$/, "");

async function dirOf(directory: Directory): Promise<string | null> {
  try {
    const r = await Filesystem.getUri({ directory, path: "" });
    return stripFile(r.uri);
  } catch {
    return null;
  }
}

async function buildInit(): Promise<InitInfo> {
  const [data, cache, ext, root] = await Promise.all([
    dirOf(Directory.Data),
    dirOf(Directory.Cache),
    dirOf(Directory.External),
    dirOf(Directory.ExternalStorage),
  ]);
  const locale = navigator.language || "en-US";
  const region = (/[-_]([A-Za-z]{2})\b/.exec(locale)?.[1] ?? "").toUpperCase();
  return {
    dataDir: data ?? "/data/data/com.blutheist.music/files",
    cacheDir: cache ?? "/data/data/com.blutheist.music/cache",
    musicDir: root ? `${root}/Music` : null,
    downloadDir: root ? `${root}/Download` : null,
    externalFilesDir: ext,
    storageRoot: root,
    locale,
    region,
    version: appVersion,
  };
}

/* ------------------------------------------------------------------ host (backend → shell) requests */

function pickFileViaInput(filters: Array<{ name: string; extensions: string[] }>): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    const exts = filters.flatMap((f) => f.extensions).filter((e) => e && e !== "*");
    // Android's chooser filters by MIME, and .m3u8/.json have none it trusts: accept both forms.
    input.accept = exts.length ? [...exts.map((e) => `.${e}`), "application/json", "text/*", "application/octet-stream"].join(",") : "*/*";
    input.style.display = "none";
    let settled = false;
    const done = (f: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function shareFiles(paths: string[], title?: string): Promise<void> {
  try {
    await Share.share({ title: title ?? "Blutheist", files: paths.map((p) => `file://${p}`), dialogTitle: title ?? "Save or share" });
  } catch {
    /* dismissed or no handler: the file still sits in the cache's exports folder */
  }
}

async function hostHandler(op: HostOp, args: unknown[]): Promise<unknown> {
  switch (op) {
    case "dialog.open": {
      const opts = (args[0] ?? {}) as { filters?: Array<{ name: string; extensions: string[] }> };
      const file = await pickFileViaInput(opts.filters ?? []);
      if (!file) return { canceled: true, filePaths: [] };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const p = await invoke<string>("android:putTemp", file.name, bytes);
      return { canceled: false, filePaths: [p] };
    }
    case "shell.openExternal":
      await Browser.open({ url: String(args[0]) });
      return null;
    case "shell.share":
      await shareFiles([String(args[0])]);
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ local cover art (localart://) */

let artBase: string | null = null;
const waitingImgs = new Set<HTMLImageElement>();
const LOCALART = /^localart:\/\/([a-f0-9]{16}\.(?:jpg|png))$/i;
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function mapArt(value: string): string | null {
  const m = LOCALART.exec(value.trim());
  return m ? `${artBase}/art/${m[1].toLowerCase()}` : null;
}

/** Android has no custom-scheme handler, so <img src="localart://x.jpg"> is pointed at the loopback server instead. */
function installLocalArtMapping(): void {
  const proto = HTMLImageElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "src");
  const origSetAttr = proto.setAttribute;
  if (!desc?.set) return;
  const apply = (img: HTMLImageElement, value: string, write: (v: string) => void): void => {
    if (!LOCALART.test(value.trim())) {
      waitingImgs.delete(img);
      write(value);
      return;
    }
    if (artBase) {
      write(mapArt(value) ?? BLANK);
    } else {
      img.dataset.localart = value.trim();
      waitingImgs.add(img);
      write(BLANK);
    }
  };
  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(this: HTMLImageElement, v: string) {
      apply(this, String(v), (x) => desc.set!.call(this, x));
    },
  });
  proto.setAttribute = function (this: HTMLImageElement, name: string, value: string): void {
    if (name.toLowerCase() === "src") apply(this, String(value), (x) => origSetAttr.call(this, "src", x));
    else origSetAttr.call(this, name, value);
  };
}

function resolveWaitingArt(): void {
  for (const img of waitingImgs) {
    const v = img.dataset.localart;
    const mapped = v ? mapArt(v) : null;
    if (mapped) img.src = mapped;
  }
  waitingImgs.clear();
}

/* ------------------------------------------------------------------ the bridge */

type Unsub = () => void;
const noop = (): void => undefined;
const sub = <T,>(ev: string) => (cb: (p: T) => void): Unsub => onEvent<T>(ev, cb);

export function createAndroidBridge(): BlutheistApi {
  installLocalArtMapping();

  const initPromise = buildInit().then((info) => connect(info, hostHandler));
  initPromise
    .then(() => invoke<number>("android:proxyPort"))
    .then((port) => {
      artBase = `http://127.0.0.1:${port}`;
      resolveWaitingArt();
    })
    .catch(() => undefined);

  // A reload of the page leaves the backend running; tell it who is asking again.
  const inv = <T = any>(ch: string, ...a: unknown[]): Promise<T> => invoke<T>(ch, ...a);

  // Exports: the backend writes the file into the cache; the share sheet is how the user saves or sends it.
  const exportThenShare = async (ch: string, ...a: unknown[]): Promise<any> => {
    const res = await inv<{ path?: string; extra?: string[]; cancelled?: boolean }>(ch, ...a);
    if (res?.path) await shareFiles([res.path, ...(res.extra ?? [])]);
    return res;
  };

  // Fullscreen on Android is just a state the shell mirrors (the system bars stay).
  const fsListeners = new Set<(fs: boolean) => void>();

  // Links: blutheist://room/CODE (invites) and blutheist://oauth/... (sign-in callback).
  void CapApp.addListener("appUrlOpen", (e) => {
    const url = e.url ?? "";
    if (/^blutheist:\/\/room\//i.test(url)) void inv("android:roomInvite", url).catch(() => undefined);
    else if (/^blutheist:\/\/oauth\//i.test(url)) void inv("android:oauthCallback", url).catch(() => undefined);
  });
  onEvent("app:reload", () => location.reload());
  onEvent("ui:openSettings", (tab: string) => {
    void import("../stores/ui").then((m) => m.useUI.getState().openSettings(tab as never));
  });

  // The document scope changes only on sign-in/out, which reloads the page; one lookup per page load is enough.
  let scopeP: Promise<string> | null = null;
  const scope = (): Promise<string> => (scopeP ??= inv<string>("data:scope"));

  const api = {
    platform: "android",
    versions: { app: appVersion, electron: "", chrome: (/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? ""), node: "" },

    /* music */
    search: (query: string, light = false) => inv("music:search", query, light),
    searchPage: (query: string, filter: string) => inv("music:searchPage", query, filter),
    searchMore: (token: string, filter: string) => inv("music:searchMore", token, filter),
    resolveVideo: (videoId: string) => inv("music:resolveVideo", videoId),
    setBackgroundMode: noop,
    discordConfigure: () => Promise.resolve({ state: "unavailable" }),
    discordStatus: () => Promise.resolve({ state: "unavailable", message: "Discord status isn't available on Android." }),
    discordSetSong: () => Promise.resolve(false),
    suggestions: (query: string) => inv("music:suggestions", query),
    getAlbum: (id: string) => inv("music:album", id),
    getArtist: (id: string) => inv("music:artist", id),
    getPlaylist: (id: string) => inv("music:playlist", id),
    getPlaylistPage: (id: string) => inv("music:playlistPage", id),
    getHome: () => inv("music:home"),
    getRadio: (id: string, token?: string) => inv("music:radio", id, token),
    getCharts: () => inv("music:charts"),
    getMoods: () => inv("music:moods"),
    getMoodCovers: (browseId: string, params: string) => inv("music:moodCovers", browseId, params),
    getMoodPage: (browseId: string, params: string) => inv("music:moodPage", browseId, params),
    marketInfo: () => inv("market:current"),
    getLyrics: (track: unknown) => inv("music:lyrics", track),
    enrichDurations: (ids: string[]) => inv("music:enrich", ids),
    playbackEvent: (event: unknown) => send("playback:event", event),
    statsSummary: (period: string) => inv("stats:summary", period),
    getStreamUrl: (id: string, forceRotate = false, quality?: string) => inv("music:stream", id, forceRotate, quality),
    localLibrary: () => inv("library:get"),
    scanLibrary: async (filterNonMusic = true) => {
      await ensureAudioPermission();
      return inv("library:scan", filterNonMusic);
    },
    setLibraryFolders: (folders: string[]) => inv("library:setFolders", folders),
    addLibraryFolders: async (paths: string[]) => {
      await ensureAudioPermission();
      return inv("library:addFolders", paths);
    },
    renameLibraryFolder: (p: string, name: string) => inv("library:renameFolder", p, name),
    removeLibraryFolder: (p: string) => inv("library:removeFolder", p),
    libraryFolderStatuses: () => inv("library:folderStatuses"),
    localTrackUrl: (id: string) => inv("library:trackurl", id),
    localArtBytes: (thumb: string) => inv("library:artbytes", thumb),
    remoteArtBytes: (url: string) => inv("art:remoteBytes", url),
    getCanvas: (q: unknown) => inv("canvas:get", q),

    /* updates (the GitHub release page is the updater on Android) */
    updateState: () => inv("updates:state"),
    checkForUpdates: () => inv("updates:check"),
    installUpdate: () => inv("updates:install"),
    restartToUpdate: () => inv("updates:restart"),
    onUpdateState: sub("updates:changed"),

    /* window chrome: none on a phone */
    windowMinimize: noop,
    windowMaximizeToggle: noop,
    windowClose: () => void CapApp.minimizeApp(),
    isMaximized: () => Promise.resolve(false),
    introDone: noop,
    naturalScrolling: () => Promise.resolve(null),
    setOverlayChrome: () => Promise.resolve("unsupported"),
    setFullScreen: (fs: boolean) => {
      fsListeners.forEach((cb) => cb(fs === true));
      return Promise.resolve(true);
    },
    onMaximizeChange: (): Unsub => noop,
    onFullScreenChange: (cb: (fs: boolean) => void): Unsub => {
      fsListeners.add(cb);
      return () => fsListeners.delete(cb);
    },

    /* miniplayer window (desktop only) */
    pipToggle: () => Promise.resolve(false),
    pipIsOpen: () => Promise.resolve(false),
    pipClose: noop,
    pipMinimize: noop,
    pipSetCompact: noop,
    pipShowMain: noop,
    pipSendState: noop,
    pipSendCommand: noop,
    onPipState: (): Unsub => noop,
    onPipCommand: (): Unsub => noop,
    onPipOpenChange: (): Unsub => noop,
    onPipNeedState: (): Unsub => noop,
    onPipCursorInside: (): Unsub => noop,

    /* persistence */
    readData: async (name: string) => {
      try {
        return await inv("data:read", name, await scope());
      } catch {
        return null;
      }
    },
    writeData: async (name: string, data: unknown) => inv("data:write", name, data, await scope()),
    resetData: () => inv("app:resetData"),

    /* backup / files */
    backupExport: () => exportThenShare("backup:export"),
    playlistExport: (name: string, m3u8: string, json: string) => exportThenShare("playlist:export", name, m3u8, json),
    playlistImport: () => inv("playlist:import"),
    spotifyPublicPlaylist: (link: string) => inv("spotify:publicPlaylist", link),
    spotifyStatus: () => inv("spotify:status"),
    spotifyConnect: () => inv("spotify:connect"),
    spotifyDisconnect: () => inv("spotify:disconnect"),
    spotifyPlaylists: () => inv("spotify:playlists"),
    spotifyPlaylist: (id: string) => inv("spotify:playlist", id),
    matchSong: (song: unknown, prefer: string) => inv("match:song", song, prefer),

    /* rooms */
    roomCurrent: () => inv("room:current"),
    roomCreate: () => inv("room:create"),
    roomJoin: (code: string) => inv("room:join", code),
    roomLeave: () => inv("room:leave"),
    roomUpdate: (change: unknown) => inv("room:update", change),
    roomHostOnly: (on: boolean) => inv("room:hostOnly", on),
    roomMakeHost: (userId: string) => inv("room:makeHost", userId),
    roomRemove: (userId: string) => inv("room:remove", userId),
    roomStash: (snapshot: unknown) => inv("room:stash", snapshot),
    roomUnstash: () => inv("room:unstash"),
    roomTakeInvite: () => inv("room:takeInvite"),
    onRoomState: sub("room:state"),
    onRoomInvite: (cb: () => void): Unsub => onEvent("room:invite", () => cb()),

    saveReplayImage: (png: Uint8Array, name: string) => exportThenShare("replay:saveImage", png, name),
    copyReplayImage: async (png: Uint8Array) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png as BlobPart], { type: "image/png" }) })]);
        return true;
      } catch {
        return false;
      }
    },
    localGainDb: (id: string) => inv("local:gainDb", id),
    getPodcast: (id: string) => inv("music:podcast", id),
    getPodcasts: () => inv("music:podcasts"),
    backupImport: () => inv("backup:import"),

    /* accounts + cloud backup */
    authGetSession: () => inv("auth:getSession"),
    authSignUp: (u: string, p: string, d: string) => inv("auth:signUp", u, p, d),
    authSignIn: (u: string, p: string) => inv("auth:signIn", u, p),
    authSignInGoogle: () => inv("auth:signInGoogle"),
    authContinueGuest: (d?: string) => inv("auth:continueGuest", d),
    authClearGuestProfile: () => inv("auth:clearGuestProfile"),
    authUsernameAvailable: (u: string) => inv("auth:usernameAvailable", u),
    authSetUsername: (u: string, d?: string) => inv("auth:setUsername", u, d),
    authSkipUsername: (d?: string) => inv("auth:skipUsername", d),
    authSetDisplayName: (n: string) => inv("auth:setDisplayName", n),
    authSignOut: () => inv("auth:signOut"),
    onAuthChanged: sub("auth:changed"),
    syncStatus: () => inv("sync:status"),
    syncNow: () => inv("sync:now"),
    syncBackupNow: () => inv("sync:backupNow"),
    syncRestoreNow: () => inv("sync:restoreNow"),
    onSyncRestored: sub("sync:restored"),

    /* macOS menu / Windows flyout: none. (Lock-screen controls come from the MediaSession plugin.) */
    onMenuCommand: (): Unsub => noop,
    menuPushState: noop,
    mediaSetMetadata: noop,
    mediaSetPosition: noop,
    onMediaAction: (): Unsub => noop,

    /* opened files */
    takeOpenedFiles: () => inv("files:take"),
    onFilesOpened: (cb: () => void): Unsub => onEvent("files:opened", () => cb()),
    openedFiles: () => inv("library:opened"),
    forgetOpenedFile: (id: string) => inv("library:forgetOpened", id),

    /* filesystem helpers */
    defaultDownloadDir: () => inv("app:defaultDownloadDir"),
    pickFolder: async () => {
      if (!(await ensureAudioPermission())) return null;
      const dir = await showFolderBrowser();
      return dir ? inv<string>("android:approveDir", dir) : null;
    },
    revealPath: () => Promise.resolve(),
    openPath: (p: string) => inv("app:openPath", p),

    /* downloads */
    startDownload: async (track: unknown, dir?: string, quality?: string, exportCompat?: boolean) => {
      if (exportCompat) await ensureAudioPermission();
      return inv("download:start", track, dir, quality, exportCompat);
    },
    cancelDownload: (id: string) => inv("download:cancel", id),
    downloadQueue: () => inv("download:queue"),
    onDownloadEvent: sub("download:event"),
    onDownloadProgress: sub("download:progress"),
  };

  return api as unknown as BlutheistApi;
}

/** Android-only extras the mobile UI uses directly. */
export const androidNative = {
  diagnostics: () => invoke<Record<string, unknown>>("android:diagnostics"),
  storageRoots: () => invoke<Array<{ label: string; path: string }>>("android:storageRoots"),
  listDir: (dir: string) =>
    invoke<{ path: string; parent: string | null; dirs: Array<{ name: string; path: string; audio: number }>; audioCount: number; readable: boolean }>("android:listDir", dir),
  requestNotifications: () => Native.requestNotifications().catch(() => ({ granted: false })),
};

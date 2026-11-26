/**
 * Blutheist backend for Android (runs inside nodejs-mobile, started by the capacitor-nodejs plugin).
 *
 * This is electron/main.ts minus everything that is a desktop window (frameless chrome, tray, PiP,
 * macOS menu, Windows media flyout, Discord, auto-updater install) and plus a handful of
 * Android-only channels (`android:*`). Every other channel keeps its Electron name and behaviour, so the
 * renderer's `window.bytune` bridge (src/mobile/androidBridge.ts) maps one-to-one.
 *
 * The music/lyrics/stream/download/stats/sync modules are the SAME files the desktop app uses
 * (electron/*.ts); `electron` resolves to ./electron-shim at bundle time.
 */
import "./polyfills"; // must stay first: fills in APIs the embedded Node lacks
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import * as downloads from "../../electron/downloads";
import * as downloaded from "../../electron/downloaded-files";
import { isKnownAudio, isPlayableAudio } from "../../electron/audio-types";
import * as canvas from "../../electron/canvas";
import * as music from "../../electron/music-service";
import { backupExport, backupImport } from "../../electron/backup";
import * as locallib from "../../electron/local-library";
import { remoteArtBytes } from "../../electron/remote-art";
import * as persist from "../../electron/persist";
import * as rooms from "../../electron/rooms";
import * as spotify from "../../electron/spotify";
import * as stats from "../../electron/stats";
import { proxyUrlFor, proxyUrlForLocalTrack, setDownloadedFileLookup, startStreamProxy } from "../../electron/stream-proxy";
import * as auth from "../../electron/supabase";
import * as sync from "../../electron/sync";
import * as updates from "../../electron/updater";
import * as transition from "../../electron/data-transition";
import { roomCodeIn } from "../../src/lib/roomSync";
import { displayNameProblem, normalizeDisplayName } from "../../src/lib/account-validators";
import type { Track } from "../../src/types";
import { app, dialog, shell } from "./electron-shim";
import { emit, init } from "./host";
import { handle as ipcHandle, on as ipcOn, start, type Transport } from "./rpc";
import { bridgeTransport, stdioTransport } from "./transport";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ approved folders */

/**
 * Filesystem allowlist (same idea as the desktop build): downloads, "open" and library imports only
 * touch app data and folders the user picked in the in-app folder browser or the default locations.
 */
const approvedDirs = new Set<string>();

function approveDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (approvedDirs.has(resolved)) return;
  approvedDirs.add(resolved);
  const stored = (persist.readData("approved-dirs") as string[] | null) ?? [];
  if (!stored.includes(resolved)) void persist.writeData("approved-dirs", [...stored, resolved]);
}

function isApprovedPath(p: string): boolean {
  const resolved = path.resolve(String(p ?? ""));
  const roots = [app.getPath("userData"), init().cacheDir, init().externalFilesDir ?? ""].filter(Boolean);
  for (const r of roots) if (resolved === r || resolved.startsWith(r + path.sep)) return true;
  for (const dir of approvedDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

function approvedFolderInputs(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid folder list");
  return value.map((dir) => {
    if (typeof dir !== "string" || !dir.trim() || !isApprovedPath(dir)) throw new Error("Folder not approved");
    return path.resolve(dir);
  });
}

/* ------------------------------------------------------------------ state */

let dataResetActive = false;
let pendingRoomInvite: string | null = null;

// Exact names used by renderer persistence; internal stores are main-only.
const RENDERER_STORES = new Set([
  "settings",
  "library",
  "player",
  "recent-searches",
  "listening-signals",
  "artist-meta-cache",
  "artist-bundle-cache",
  "artist-about-cache",
  "home-market-cache",
  "lyrics-nudges",
  "recent-items",
  "explore-covers",
  "listen-journal",
  "home-engagement",
]);
function assertRendererStore(name: unknown): asserts name is string {
  if (typeof name !== "string" || !RENDERER_STORES.has(name)) throw new Error("Store not allowed");
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const uuid = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error("Not a member");
  return v;
};

/* ------------------------------------------------------------------ Android-only helpers */

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|webm|wma|alac|aiff?)$/i;

interface DirListing {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; audio: number }>;
  audioCount: number;
  readable: boolean;
}

/** Folders allowed in the in-app folder browser: shared storage and the app's own dirs, nothing else. */
function browsableRoots(): string[] {
  const i = init();
  const roots = new Set<string>();
  if (i.storageRoot) roots.add(i.storageRoot);
  roots.add("/storage");
  roots.add(i.dataDir);
  if (i.externalFilesDir) roots.add(i.externalFilesDir);
  return [...roots];
}

function insideBrowsable(p: string): boolean {
  const r = path.resolve(p);
  return browsableRoots().some((root) => r === root || r.startsWith(root + path.sep));
}

async function listDir(dir: string): Promise<DirListing> {
  const resolved = path.resolve(dir);
  if (!insideBrowsable(resolved)) throw new Error("That folder can't be browsed");
  let entries: fs.Dirent[] = [];
  let readable = true;
  try {
    entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  } catch {
    readable = false;
  }
  const dirs: DirListing["dirs"] = [];
  let audioCount = 0;
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isFile() && AUDIO_EXT.test(e.name)) audioCount++;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    const child = path.join(resolved, e.name);
    // "Android" holds other apps' private data and is empty or denied to us; skip it as a candidate.
    if (resolved === (init().storageRoot ?? "") && e.name === "Android") continue;
    let audio = 0;
    try {
      // One shallow look so the browser can say "12 songs" next to each folder.
      for (const c of await fs.promises.readdir(child, { withFileTypes: true })) {
        if (c.isFile() && AUDIO_EXT.test(c.name)) audio++;
      }
    } catch {
      /* unreadable: shown with 0 */
    }
    dirs.push({ name: e.name, path: child, audio });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parentDir = path.dirname(resolved);
  return {
    path: resolved,
    parent: parentDir !== resolved && insideBrowsable(parentDir) ? parentDir : null,
    dirs,
    audioCount,
    readable,
  };
}

/** Internal storage plus any SD card / USB volume mounted under /storage. */
async function storageRoots(): Promise<Array<{ label: string; path: string }>> {
  const i = init();
  const out: Array<{ label: string; path: string }> = [];
  if (i.storageRoot) out.push({ label: "Internal storage", path: i.storageRoot });
  try {
    for (const e of await fs.promises.readdir("/storage", { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === "emulated" || e.name === "self") continue;
      const p = path.join("/storage", e.name);
      try {
        await fs.promises.access(p, fs.constants.R_OK);
        out.push({ label: `SD card / USB (${e.name})`, path: p });
      } catch {
        /* not readable */
      }
    }
  } catch {
    /* /storage unreadable */
  }
  return out;
}

/** Quick facts for the Settings "About / storage" rows and for diagnosing a build that misbehaves. */
function diagnostics(): Record<string, unknown> {
  const i = init();
  return {
    node: process.version,
    arch: process.arch,
    platform: process.platform,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    cpus: os.cpus().length,
    dataDir: i.dataDir,
    musicDir: i.musicDir,
  };
}

/* ------------------------------------------------------------------ IPC */

function registerIpc(): void {
  const handle = ipcHandle;
  const on = ipcOn;

  /* ---- music ---- */
  handle("music:search", (query: string, light?: boolean) => music.searchAll(query, light === true));
  handle("music:searchPage", (query: string, filter: music.SearchFilter) => music.searchPage(String(query ?? ""), filter as music.SearchFilter));
  // A pasted YouTube link: only a well-formed video id is looked up; the reply is the song or the reason it can't play.
  handle("music:resolveVideo", async (videoId: unknown) => {
    if (typeof videoId !== "string") return { ok: false, error: "That doesn't look like a valid song link." };
    try {
      return { ok: true, track: await music.resolveVideo(videoId) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  handle("music:searchMore", (token: string, filter: music.SearchFilter) => music.searchMore(String(token ?? ""), filter as music.SearchFilter));
  // The search field holds at most 200 characters; anything longer didn't come from it.
  handle("music:suggestions", (query: unknown) => (typeof query === "string" && query.length <= 200 ? music.getSuggestions(query) : { items: [] }));
  handle("music:artist", (id: string) => music.getArtistPage(id));
  handle("music:album", (id: string) => music.getAlbum(id));
  handle("music:playlist", (id: string) => music.getPlaylist(id));
  handle("music:playlistPage", (id: string) => music.getPlaylistPage(String(id ?? "")));
  handle("music:home", () => music.getHome());
  handle("music:radio", (id: unknown, token?: unknown) => {
    // Only a bare YouTube video id has a radio; local:/other ids are refused.
    const videoId = typeof id === "string" ? id : "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("No radio for this track");
    const next = typeof token === "string" && token.length > 0 && token.length <= 4096 ? token : undefined;
    return music.getRadio(videoId, next);
  });
  handle("music:charts", () => music.getCharts());
  handle("music:moods", () => music.getMoods());
  const moodArgs = (browseId: unknown, params: unknown): [string, string] => {
    if (browseId !== "FEmusic_moods_and_genres_category" || typeof params !== "string" || !/^[A-Za-z0-9_%=-]{1,300}$/.test(params)) {
      throw new Error("Not a mood page");
    }
    return [browseId, params];
  };
  handle("music:moodCovers", (browseId: unknown, params: unknown) => music.getMoodCovers(...moodArgs(browseId, params)));
  handle("music:moodPage", (browseId: unknown, params: unknown) => music.getMoodPage(...moodArgs(browseId, params)));
  handle("market:current", () => music.currentMarket());
  handle("music:lyrics", (meta: music.LyricsMeta) => music.getLyrics(meta));
  handle("music:podcast", (id: unknown) => {
    if (typeof id !== "string" || !/^MPSP[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Not a podcast");
    return music.getPodcast(id);
  });
  handle("music:podcasts", () => music.getPodcasts());
  handle("local:gainDb", (id: unknown) => (typeof id === "string" && id.startsWith("local:") && id.length <= 200 ? music.localGainDb(id) : null));
  handle("music:enrich", (ids: string[]) => music.enrichDurations(Array.isArray(ids) ? ids : []));
  handle("music:stream", async (id: unknown, retry?: boolean, quality?: string) => {
    // Hand the page a loopback proxy URL — this process does the actual upstream traffic (stream-proxy.ts).
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid track id");
    await startStreamProxy();
    const maxKbps = quality === "low" ? 64 : undefined;
    if (retry === true) music.retryStream(id);
    return proxyUrlFor(id, retry === true, maxKbps);
  });

  /* ---- local library ---- */
  handle("library:get", () => locallib.readLocalLibrary());
  // Android has no "Open with" hand-over of readable paths (content:// URIs), so nothing ever queues here.
  handle("files:dropped", () => undefined);
  handle("files:take", () => []);
  handle("library:opened", () => locallib.openedFiles());
  handle("library:forgetOpened", (id: unknown) => (typeof id === "string" && id.startsWith("local:") ? locallib.forgetOpenedFile(id) : locallib.openedFiles()));
  handle("library:scan", async (filterNonMusic?: boolean) => locallib.scanLibrary(filterNonMusic !== false));
  handle("library:setFolders", async (folders: string[]) => locallib.setLibraryFolders(approvedFolderInputs(folders, 8)));
  handle("library:addFolders", async (paths: string[]) => {
    const clean = approvedFolderInputs(Array.isArray(paths) ? paths.slice(0, 8) : [], 8);
    const res = await locallib.addLibraryFolders(clean);
    for (const f of res.added) approveDir(f.path);
    return res;
  });
  handle("library:renameFolder", (folderPath: string, displayName: string) => locallib.renameLibraryFolder(String(folderPath ?? ""), displayName));
  handle("library:removeFolder", (folderPath: string) => locallib.removeLibraryFolder(String(folderPath ?? "")));
  handle("library:folderStatuses", () => locallib.folderStatuses());
  handle("library:trackurl", async (id: string) => {
    const p = locallib.localStreamPath(String(id ?? ""));
    if (!p) return null;
    await startStreamProxy();
    return proxyUrlForLocalTrack(String(id)) ?? pathToFileURL(p).toString();
  });
  handle("library:artbytes", (thumb: string) => {
    const art = locallib.readLocalArtThumb(String(thumb ?? ""));
    return art ? art.data : null;
  });
  handle("art:remoteBytes", (url: unknown) => remoteArtBytes(typeof url === "string" ? url : ""));

  /* ---- rooms ---- */
  rooms.onRoomChange((view) => emit("room:state", view));
  handle("room:current", () => rooms.roomView());
  handle("room:create", () => rooms.createRoom());
  handle("room:join", (code: unknown) => {
    const c = typeof code === "string" && code.length <= 100 ? roomCodeIn(code) : null;
    if (!c) throw new Error("That isn't a room code.");
    return rooms.joinRoom(c);
  });
  handle("room:leave", () => rooms.leaveRoom());
  handle("room:update", (change: unknown) => {
    const c = change as Record<string, unknown> | null;
    const ok =
      !!c && typeof c === "object" &&
      typeof c.baseSeq === "number" && Number.isSafeInteger(c.baseSeq) && c.baseSeq >= 0 &&
      (c.track === null || (typeof c.track === "object" && !Array.isArray(c.track))) &&
      typeof c.positionMs === "number" && Number.isFinite(c.positionMs) && c.positionMs >= 0 && c.positionMs <= 86_400_000 &&
      typeof c.playing === "boolean" && typeof c.lead === "boolean" &&
      Array.isArray(c.queue) && c.queue.length <= 200 &&
      typeof c.note === "string" && c.note.length <= 200;
    if (!ok) throw new Error("Not a room change");
    return rooms.updateRoom(c as unknown as Parameters<typeof rooms.updateRoom>[0]);
  });
  handle("room:hostOnly", (on_: unknown) => {
    if (typeof on_ !== "boolean") throw new Error("Not a setting");
    return rooms.setHostOnly(on_);
  });
  handle("room:makeHost", (userId: unknown) => rooms.makeHost(uuid(userId)));
  handle("room:remove", (userId: unknown) => rooms.removeMember(uuid(userId)));
  handle("room:stash", (snapshot: unknown) => {
    const s = snapshot as { queue?: unknown } | null;
    if (!s || typeof s !== "object" || !Array.isArray(s.queue) || s.queue.length > 5000 || JSON.stringify(s).length > 5_000_000) {
      throw new Error("Not a queue");
    }
    return rooms.stash(s);
  });
  handle("room:unstash", () => rooms.unstash());
  handle("room:takeInvite", () => {
    const code = pendingRoomInvite;
    pendingRoomInvite = null;
    return code;
  });
  // A blutheist://room/CODE link reaches the app through Android's intent system (the WebView forwards it).
  handle("android:roomInvite", (url: unknown) => {
    const code = typeof url === "string" ? roomCodeIn(url) : null;
    if (!code) return false;
    pendingRoomInvite = code;
    emit("room:invite", null);
    return true;
  });
  handle("android:oauthCallback", async (url: unknown) => {
    if (typeof url !== "string" || url.length > 4000) return false;
    await auth.handleOAuthCallback(url);
    return true;
  });

  /* ---- spotify ---- */
  handle("spotify:status", () => spotify.spotifyStatus());
  // "Connect Spotify" opens a desktop sign-in window and reads its session cookie; there is no such window
  // on Android. Public playlist links (spotify:publicPlaylist) need no sign-in and work everywhere.
  handle("spotify:connect", () => {
    throw new Error("Connecting a Spotify account isn't available on Android yet. Paste a public playlist link instead.");
  });
  handle("spotify:disconnect", async () => {
    await spotify.disconnectSpotify();
    return spotify.spotifyStatus();
  });
  handle("spotify:playlists", () => spotify.spotifyPlaylists());
  handle("spotify:playlist", (id: unknown) => {
    if (typeof id !== "string" || (id !== spotify.LIKED_ID && !/^[A-Za-z0-9]{22}$/.test(id))) throw new Error("Not a Spotify playlist");
    return spotify.spotifyPlaylist(id);
  });
  handle("spotify:publicPlaylist", (link: unknown) => {
    if (typeof link !== "string" || link.length > 500) throw new Error("That isn't a link to a Spotify playlist.");
    return spotify.publicPlaylist(link);
  });
  handle("match:song", (song: unknown, prefer: unknown) => {
    const s = song as Record<string, unknown> | null;
    const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
    if (!s || typeof s !== "object" || !isText(s.title, 300) || !s.title.trim() || !isText(s.artist, 300)) throw new Error("Not a song");
    const duration = typeof s.duration === "number" && Number.isFinite(s.duration) && s.duration > 0 && s.duration < 86_400 ? Math.round(s.duration) : 0;
    return spotify.matchSong(
      {
        title: s.title,
        artist: s.artist,
        duration,
        ...(isText(s.album, 300) ? { album: s.album } : {}),
        ...(typeof s.spotifyId === "string" && /^[A-Za-z0-9]{22}$/.test(s.spotifyId) ? { spotifyId: s.spotifyId } : {}),
      },
      typeof prefer === "string" ? prefer : ""
    );
  });

  handle("canvas:get", (q: { title?: string; artist?: string; album?: string }) =>
    canvas.canvasFor(String(q?.title ?? ""), String(q?.artist ?? ""), q?.album ? String(q.album) : undefined)
  );

  /* ---- updates (the app store / GitHub release page is the updater on Android) ---- */
  handle("updates:state", () => updates.updateState());
  handle("updates:check", () => updates.checkForUpdates(false));
  handle("updates:install", () => updates.installUpdate());
  handle("updates:restart", () => updates.restartToUpdate());

  /* ---- listening telemetry / Replay ---- */
  on("playback:event", (ev: { type: string; track?: Track; positionSec?: number; playedSec?: number; deltaMs?: number }) => {
    if (dataResetActive || !ev || typeof ev !== "object") return;
    if (ev.type === "start" && ev.track?.id) stats.noteTrackStart(ev.track.id);
    if ((ev.type === "progress" || ev.type === "stop" || ev.type === "pause") && ev.track && !ev.track.episode && (ev.deltaMs ?? 0) > 0) {
      stats.recordListening(ev.track, ev.deltaMs as number);
    }
  });
  handle("stats:summary", (period: string) => {
    const p = (["month", "lastMonth", "year", "all"] as const).find((x) => x === period) ?? "month";
    return stats.summary(p);
  });

  /* ---- persistence ---- */
  handle("data:scope", () => transition.serializeData(async () => transition.documentScope()));
  handle("data:read", (name: string, scope: string) => {
    assertRendererStore(name);
    return transition.serializeData(async () => transition.readForDocument(name, scope));
  });
  handle("data:write", (name: string, data: unknown, scope: string) =>
    transition.serializeData(async () => {
      assertRendererStore(name);
      if (await transition.writeForDocument(name, data, scope)) {
        sync.noteLocalWrite(String(name ?? ""));
        if (name === "library") downloaded.noteLibrary(data);
      }
    })
  );
  handle("app:resetData", () =>
    transition.serializeData(async () => {
      dataResetActive = true;
      try {
        await rooms.leaveRoom().catch(() => undefined);
        transition.invalidateResetDocuments();
        sync.resetSyncState();
        await auth.signOut();
        stats.resetStats();
        await Promise.all([downloads.resetDownloads(), locallib.resetLocalLibrary(), spotify.forgetSpotify()]);
        await persist.resetAppData();
        downloaded.noteLibrary(null);
        approvedDirs.clear();
        try {
          approveDir(await downloads.defaultDownloadDir());
          approveDir(downloads.exportDownloadDir());
        } catch {
          /* approved lazily on next download */
        }
      } finally {
        dataResetActive = false;
      }
    })
  );

  /* ---- files / downloads ---- */
  handle("app:defaultDownloadDir", () => downloads.defaultDownloadDir());
  // The folder picker is an in-app browser on Android (src/mobile/FolderBrowser.tsx) that approves through android:approveDir.
  handle("app:pickFolder", () => null);
  handle("app:revealPath", () => undefined);
  handle("app:openPath", async (p: string) => {
    if (!p || !isApprovedPath(p)) return "Not allowed";
    return shell.openPath(p);
  });
  handle("android:approveDir", (dir: unknown) => {
    if (typeof dir !== "string" || !dir.trim() || !insideBrowsable(dir)) throw new Error("That folder can't be used");
    approveDir(dir);
    return path.resolve(dir);
  });
  handle("android:listDir", (dir: unknown) => listDir(typeof dir === "string" && dir ? dir : init().storageRoot ?? "/storage"));
  handle("android:storageRoots", () => storageRoots());
  handle("android:diagnostics", () => diagnostics());
  handle("android:proxyPort", async () => startStreamProxy());
  // The WebView's file chooser hands a picked file over as bytes; it becomes a temp file the dialog shim can return.
  handle("android:putTemp", async (name: unknown, bytes: unknown) => {
    if (typeof name !== "string" || !(bytes instanceof Uint8Array)) throw new Error("Invalid file");
    if (bytes.length > 64 * 1024 * 1024) throw new Error("That file is too large");
    const dir = path.join(init().cacheDir, "incoming");
    await fs.promises.mkdir(dir, { recursive: true });
    // Keep the extension (the importers look at it) but never the caller's directory parts.
    const safe = path.basename(name).replace(/[^A-Za-z0-9._ -]/g, "_").slice(-120) || "file";
    const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
    await fs.promises.writeFile(file, bytes);
    return file;
  });

  handle("download:start", async (track: Track, dir?: string, quality?: string, exportCompat?: boolean) => {
    if (dir && !isApprovedPath(dir)) throw new Error("Download folder not approved");
    if (exportCompat === true) approveDir(downloads.exportDownloadDir());
    const caps: Record<string, number | undefined> = { standard: 128, high: 192, lossless: undefined };
    return downloads.enqueueDownload(track, dir, quality ? caps[quality] : undefined, exportCompat === true);
  });
  handle("download:cancel", (id: string) => downloads.cancelDownload(String(id ?? "")));
  handle("download:queue", () => downloads.queueSnapshot());
  downloads.addDownloadListener((e) => {
    if (e.type === "done" && e.path) downloaded.noteDownloaded(e.id, e.path);
    emit("download:event", e);
  });
  // Downloaded songs play from their files — only from approved folders, and only formats that play.
  setDownloadedFileLookup((id) => {
    const file = downloaded.downloadedFilePath(id);
    return file && isApprovedPath(file) && isPlayableAudio(file) ? file : null;
  });

  /* ---- backup / playlist files / replay image (dialogs are the shim's: chooser in, share-sheet out) ---- */
  handle("backup:export", () => backupExport(null));
  const PLAYLIST_FILE_MAX = 5 * 1024 * 1024;
  handle("playlist:export", async (name: unknown, m3u8: unknown, json: unknown) => {
    if (typeof name !== "string" || typeof m3u8 !== "string" || typeof json !== "string") throw new Error("Invalid playlist export");
    if (m3u8.length > PLAYLIST_FILE_MAX || json.length > PLAYLIST_FILE_MAX) throw new Error("Playlist too large to export");
    const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 100) || "playlist";
    const res = await dialog.showSaveDialog({ title: "Export playlist", defaultPath: `${safeName}.m3u8` });
    if (res.canceled || !res.filePath) return { cancelled: true };
    await fs.promises.writeFile(res.filePath, m3u8, "utf-8");
    // The JSON form (Blutheist playlist) travels alongside; the renderer's share sheet offers both.
    const jsonPath = res.filePath.replace(/\.m3u8$/i, "") + ".json";
    await fs.promises.writeFile(jsonPath, json, "utf-8");
    return { path: res.filePath, extra: [jsonPath] };
  });
  handle("playlist:import", async () => {
    const res = await dialog.showOpenDialog({
      title: "Import playlist",
      properties: ["openFile"],
      filters: [{ name: "Playlists and song lists", extensions: ["m3u8", "m3u", "json", "csv", "txt"] }],
    });
    const file = res.canceled ? undefined : res.filePaths[0];
    if (!file) return null;
    if ((await fs.promises.stat(file)).size > PLAYLIST_FILE_MAX) throw new Error("That file is too large for a playlist");
    // The picked file keeps the temp prefix android:putTemp adds; strip it for the playlist's name.
    const base = path.basename(file).replace(/^[a-z0-9]+-/, "");
    return {
      name: base.replace(/\.(m3u8?|json|csv|txt)$/i, ""),
      ext: path.extname(file).slice(1).toLowerCase(),
      text: await fs.promises.readFile(file, "utf-8"),
    };
  });
  handle("backup:import", () => backupImport(null));
  const REPLAY_IMAGE_MAX = 20 * 1024 * 1024;
  handle("replay:saveImage", async (bytes: unknown, name: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > REPLAY_IMAGE_MAX) throw new Error("Invalid image");
    const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("Not a PNG image");
    const safeName = (typeof name === "string" ? name : "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 100) || "Blutheist Replay";
    const res = await dialog.showSaveDialog({ title: "Save your Replay", defaultPath: `${safeName}.png` });
    if (res.canceled || !res.filePath) return { cancelled: true };
    const file = /\.png$/i.test(res.filePath) ? res.filePath : `${res.filePath}.png`;
    await fs.promises.writeFile(file, png);
    return { path: file };
  });

  /* ---- accounts (Supabase) + cloud backup: off unless ACCOUNTS_ENABLED, exactly like desktop ---- */
  handle("auth:getSession", () => auth.sessionInfo());
  const signIn = (authenticate: () => Promise<auth.SessionInfo>) =>
    transition.serializeData(async () => {
      await persist.drainWrites();
      await rooms.leaveRoom().catch(() => undefined);
      const previous = transition.currentOwner();
      const info = await authenticate();
      const migrateGuest = previous === "guest" && info.isNewAccount === true;
      await transition.changeOwner(info.userId ?? "guest", migrateGuest);
      if (previous !== info.userId) {
        sync.resetSyncState(info.userId ?? undefined);
        stats.reloadStore();
      }
      if (migrateGuest && info.userId) await spotify.moveGuestSpotify(info.userId);
      await auth.syncDisplayName();
      await sync.syncNowExclusive().catch((err) => {
        console.error("[blutheist] login sync failed (account data not pulled):", err instanceof Error ? err.message : err);
        sync.noteSyncFailure(err);
      });
      emit("app:reload", null);
      return info;
    });
  handle("auth:signUp", (username: string, password: string, displayName: unknown) => signIn(() => auth.signUp(username, password, text(displayName) ?? "")));
  handle("auth:signIn", (username: string, password: string) => signIn(() => auth.signIn(username, password)));
  handle("auth:signInGoogle", () => signIn(() => auth.signInGoogle()));
  handle("auth:continueGuest", (displayName: unknown) =>
    transition.serializeData(async () => {
      const name = normalizeDisplayName(text(displayName) ?? "");
      const problem = name ? displayNameProblem(name) : null;
      if (problem) throw new Error(problem);
      await transition.changeOwner("guest", false);
      sync.resetSyncState();
      stats.reloadStore();
      const info = await auth.continueAsGuest(name || undefined);
      emit("app:reload", null);
      return info;
    })
  );
  handle("auth:clearGuestProfile", () => auth.clearGuestProfile());
  handle("auth:usernameAvailable", async (username: string) => {
    const problem = auth.validateUsername(String(username ?? ""));
    if (problem) return { available: false, reason: problem };
    try {
      return { available: await auth.usernameAvailableToUser(String(username), auth.sessionInfo().userId) };
    } catch (err) {
      return { available: null, reason: err instanceof Error ? err.message : "Network error" };
    }
  });
  handle("auth:setUsername", (username: string, displayName: unknown) => auth.setUsername(username, text(displayName)));
  handle("auth:skipUsername", (displayName: unknown) => auth.skipUsernameClaim(text(displayName)));
  handle("auth:setDisplayName", (name: unknown) => auth.setDisplayName(text(name) ?? ""));
  handle("auth:signOut", () =>
    transition.serializeData(async () => {
      await persist.drainWrites();
      await sync.syncNowExclusive().catch((err) => {
        console.error("[blutheist] logout backup failed:", err instanceof Error ? err.message : err);
        sync.noteSyncFailure(err);
      });
      await rooms.leaveRoom().catch(() => undefined);
      const info = await auth.signOut();
      await transition.changeOwner("guest", false);
      sync.resetSyncState();
      stats.reloadStore();
      emit("app:reload", null);
      return info;
    })
  );
  handle("sync:status", () => sync.syncStatus());
  stats.onStoreWrite(() => sync.noteLocalWrite(stats.HISTORY_STORE));
  handle("sync:now", () => sync.syncNow());
  handle("sync:backupNow", () => sync.backupNow());
  handle("sync:restoreNow", () => sync.restoreNow());
}

/* ------------------------------------------------------------------ boot */

async function boot(): Promise<void> {
  // The same start-up sequence as electron/main.ts's app.whenReady(), minus windows.
  persist.migrateLegacyData();
  transition.initializeOwner();
  auth.registerProtocol();
  sync.bindClient(auth.getClient);
  sync.bindRestoredNotifier((stores, seq) => emit("sync:restored", { stores, seq }));
  void auth.initAuth().then(() => {
    if (auth.sessionInfo().mode === "account") void sync.syncNow().catch(() => undefined);
    void auth
      .syncDisplayName()
      .then((changed) => {
        if (changed) emit("auth:changed", auth.sessionInfo());
      })
      .catch(() => undefined);
    void rooms.recover().catch(() => undefined);
  });

  // Approvals: the default download place, the shared Music folder export, the user's library folders, and earlier picks.
  try {
    approveDir(await downloads.defaultDownloadDir());
  } catch {
    /* approved lazily on first download */
  }
  try {
    approveDir(downloads.exportDownloadDir());
  } catch {
    /* approved lazily on download */
  }
  const lib = locallib.readLocalLibrary();
  for (const f of lib.folders) approveDir(f.path);
  for (const d of (persist.readData("approved-dirs") as string[] | null) ?? []) {
    if (typeof d === "string") approvedDirs.add(path.resolve(d));
  }

  registerIpc();
  stats.initStats();
  void startStreamProxy().catch((err) => console.warn("[blutheist] stream proxy failed:", err));
  updates.startUpdates(
    (s) => emit("updates:changed", s),
    () => emit("ui:openSettings", "about")
  );
  void isKnownAudio; // referenced by the library scanner; kept so bundlers never drop the module
}

/* ------------------------------------------------------------------ entry */

function main(): void {
  process.on("uncaughtException", (err) => {
    console.error("[blutheist] uncaught exception:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.warn("[blutheist] unhandled rejection:", err instanceof Error ? err.message : err);
  });

  const wantStdio = process.argv.includes("--stdio");
  const transport: Transport | null = wantStdio ? stdioTransport() : bridgeTransport() ?? null;
  if (!transport) {
    console.error("[blutheist] no transport: run inside nodejs-mobile, or pass --stdio");
    return;
  }
  start(transport, boot);
}

main();

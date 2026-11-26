/**
 * Runs before the rest of the app (it is main.tsx's first import).
 *
 * On Android it installs `window.bytune` SYNCHRONOUSLY — lib/platform.ts reads it while it is being imported —
 * then wires the things a phone needs that a desktop window doesn't: the hardware Back button, system bars,
 * the lock-screen media session, the device performance class, and a start-up/failure notice for the backend.
 */
import { isAndroid, applyPerf, getPerfPref, setPerfPref } from "./env";
import { androidNative, createAndroidBridge } from "./androidBridge";

import { onStatus, failureMessage } from "./nodeLink";
// Side effect: makes navigator.mediaSession drive the Android notification / lock screen / headset buttons,
// and keeps the app alive in the background while a song plays.
import "@jofr/capacitor-media-session";

if (isAndroid) {
  if (!window.bytune) window.bytune = createAndroidBridge();
  const root = document.documentElement;
  root.classList.add("platform-android");
  applyPerf();
  // The Your-Library panel is a drawer here: always open, never the icon-only strip.
  try {
    localStorage.setItem("blutheist.libraryWidth", "250");
  } catch {
    /* storage unavailable */
  }
  void setupNative();
  watchBackend();
  void reportPreviousCrash();
}

/* ------------------------------------------------------------------ system bars, Back button */

async function setupNative(): Promise<void> {
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#000000" });
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch {
    /* the theme in styles.xml already paints black bars */
  }

  // No native long-press menus (Save image / Open link): the app's own context menu replaces them.
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
    },
    true
  );

  const { App } = await import("@capacitor/app");
  void App.addListener("backButton", () => {
    void handleBack(() => void App.minimizeApp());
  });
}

async function handleBack(minimize: () => void): Promise<void> {
  const w = window as unknown as { __folderBrowserOpen?: boolean };
  if (w.__folderBrowserOpen) {
    window.dispatchEvent(new Event("blutheist-folder-browser-close"));
    return;
  }
  const [{ useUI }, { useMobileUI }] = await Promise.all([import("../stores/ui"), import("./mobileUi")]);
  const ui = useUI.getState();
  const mui = useMobileUI.getState();
  // The topmost layer closes first.
  if (ui.dialog) return ui.closeDialog();
  if (ui.contextMenu) return ui.closeContextMenu();
  if (ui.playlistPicker) return ui.closePlaylistPicker();
  if (ui.floating) return ui.closeFloating();
  if (mui.drawerOpen) return mui.setDrawer(false);
  if (ui.rightPanel !== "details") return useUI.setState({ rightPanel: "details" });
  if (ui.nowPlayingOpen) return ui.toggleNowPlaying();
  if (ui.lyricsCenter) return useUI.setState({ lyricsCenter: false });
  const active = document.activeElement as HTMLElement | null;
  if (active && active.tagName === "INPUT") {
    active.blur();
    return;
  }
  if (ui.navPast.length > 0) return ui.goBack();
  minimize();
}

/* ------------------------------------------------------------------ backend start-up / failure notice */

function watchBackend(): void {
  let box: HTMLDivElement | null = null;
  const show = (title: string, body: string, retry: boolean): void => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;font:15px/1.5 system-ui,sans-serif";
      document.body.appendChild(box);
    }
    box.innerHTML = "";
    const h = document.createElement("div");
    h.style.cssText = "font-size:20px;font-weight:700;margin-bottom:10px";
    h.textContent = title;
    const p = document.createElement("div");
    p.style.cssText = "max-width:340px;opacity:.7;word-break:break-word";
    p.textContent = body;
    box.append(h, p);
    if (retry) {
      const b = document.createElement("button");
      b.textContent = "Try again";
      b.style.cssText = "margin-top:22px;padding:12px 26px;border-radius:999px;border:0;background:#fff;color:#000;font-weight:700;font-size:15px";
      b.onclick = () => location.reload();
      box.appendChild(b);
    }
  };
  const hide = (): void => {
    box?.remove();
    box = null;
  };

  let slowTimer: ReturnType<typeof setTimeout> | null = window.setTimeout(() => {
    show("Getting things ready…", "The first start unpacks the music engine and can take up to a minute. This only happens once.", false);
  }, 20_000);

  onStatus((s) => {
    if (s.phase === "ready") {
      if (slowTimer) window.clearTimeout(slowTimer);
      slowTimer = null;
      hide();
    } else if (s.phase === "failed") {
      if (slowTimer) window.clearTimeout(slowTimer);
      slowTimer = null;
      show("The music engine didn't start", s.message ?? failureMessage() ?? "Unknown error", true);
    }
  });
}

/* ------------------------------------------------------------------ "closed unexpectedly" report */

/**
 * If the previous run died, say so — straight away, on top of the intro, so it is seen even if the app is
 * about to die again — show what Android and the app recorded, and fall back to lighter graphics. The
 * report can be copied or shared, which is what makes a crash fixable.
 */
async function reportPreviousCrash(): Promise<void> {
  const text = (await androidNative.lastCrash()).trim();
  if (!text) return;

  // Lighter effects after a memory-related death (the user can change it in Settings → Performance).
  if (/WEB ENGINE|LOW_MEMORY|CRASH_NATIVE|EXCESSIVE/.test(text) && getPerfPref() === "auto") setPerfPref("low");

  const box = document.createElement("div");
  box.setAttribute("role", "alertdialog");
  box.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.94);color:#fff;display:flex;flex-direction:column;" +
    "padding:calc(env(safe-area-inset-top,0px) + 20px) 18px calc(env(safe-area-inset-bottom,0px) + 18px);font:15px/1.5 system-ui,sans-serif";
  const h = document.createElement("div");
  h.style.cssText = "font-size:19px;font-weight:700;margin-bottom:6px";
  h.textContent = "Blutheist closed unexpectedly last time";
  const p = document.createElement("div");
  p.style.cssText = "opacity:.7;font-size:13.5px;margin-bottom:10px";
  p.textContent = "Graphics effects were lowered to be safe. Please copy this report and send it so it can be fixed.";
  const pre = document.createElement("pre");
  pre.style.cssText =
    "flex:1;min-height:0;overflow:auto;margin:0 0 12px;padding:10px;border-radius:12px;background:#111;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word";
  pre.textContent = text;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:10px";
  const btn = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "flex:1;height:46px;border-radius:999px;border:0;font-weight:700;font-size:15px;" +
      (primary ? "background:#fff;color:#000" : "background:#26262a;color:#fff");
    b.onclick = onClick;
    return b;
  };
  const copy = btn("Copy", false, () => {
    void navigator.clipboard?.writeText(text).then(
      () => (copy.textContent = "Copied"),
      () => (copy.textContent = "Select text to copy")
    );
  });
  const share = btn("Share", false, () => {
    void import("@capacitor/share").then((m) => m.Share.share({ title: "Blutheist crash report", text }).catch(() => undefined));
  });
  const go = btn("Continue", true, () => {
    void androidNative.clearLastCrash();
    box.remove();
  });
  row.append(copy, share, go);
  box.append(h, p, pre, row);
  document.body.appendChild(box);
}

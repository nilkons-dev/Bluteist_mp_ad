/**
 * Runs before the rest of the app (it is main.tsx's first import).
 *
 * On Android it installs `window.bytune` SYNCHRONOUSLY — lib/platform.ts reads it while it is being imported —
 * then wires the things a phone needs that a desktop window doesn't: the hardware Back button, system bars,
 * the lock-screen media session, the device performance class, and a start-up/failure notice for the backend.
 */
import { isAndroid, applyPerf } from "./env";
import { createAndroidBridge } from "./androidBridge";
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

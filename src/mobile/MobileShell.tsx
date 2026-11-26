/**
 * The phone layout. It re-uses every desktop store, view and animated component; only the arrangement changes:
 *
 *   top bar (the real TopBar, compacted by mobile.css: brand · back · search · profile)
 *   page            the same views, in the same scroller
 *   mini player     cover · title · prev / play / next, a hairline of progress; tap = Now Playing
 *   bottom tabs     Home · Search · Library · Menu (Menu opens the full "Your Library" panel as a drawer)
 *   queue / room    the right rail, as a bottom sheet
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Home, Library as LibraryIcon, Menu as MenuIcon, Pause, Play, Search, SkipBack, SkipForward, X } from "lucide-react";
import { TopBar } from "../components/TopBar";
import { Sidebar } from "../components/Sidebar";
import { RightRail } from "../components/RightRail";
import { NowPlaying } from "../components/NowPlaying";
import { Dialog } from "../components/primitives";
import { FloatingWindows } from "../components/FloatingWindows";
import { PlaylistPicker } from "../components/PlaylistPicker";
import { ContextMenu } from "../components/ContextMenu";
import { Toasts } from "../components/Toasts";
import { SpCoverNote } from "../components/SpotifyIcons";
import { FitText } from "../components/FitText";
import { usePlayer, shownTrack } from "../stores/player";
import { useUI } from "../stores/ui";
import { upgradeArtwork } from "../lib/artwork";
import { shortTitle } from "../lib/format";
import { useMobileUI } from "./mobileUi";

/** True while the on-screen keyboard is up (the viewport lost a big slice of its height). */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let base = window.innerHeight;
    const check = (): void => {
      // Rotation changes the baseline; a keyboard only ever shrinks the height.
      if (window.innerHeight > base) base = window.innerHeight;
      setOpen(window.innerHeight < base * 0.78);
    };
    const onOrient = (): void => {
      base = window.innerHeight;
      check();
    };
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", onOrient);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", onOrient);
    };
  }, []);
  return open;
}

function MiniPlayer() {
  const track = usePlayer(shownTrack);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const toggleNowPlaying = useUI((s) => s.toggleNowPlaying);
  const startY = useRef<number | null>(null);

  if (!track) return null;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

  return (
    <div
      className="m-mini"
      role="contentinfo"
      aria-label="Now playing"
      onTouchStart={(e) => {
        startY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        const y0 = startY.current;
        startY.current = null;
        const y1 = e.changedTouches[0]?.clientY;
        // A swipe up on the bar opens Now Playing, like every phone player.
        if (y0 !== null && y1 !== undefined && y0 - y1 > 36) toggleNowPlaying();
      }}
    >
      <button className="m-mini-main m-tap" onClick={toggleNowPlaying} aria-label="Open Now playing">
        <span className="m-mini-art">
          {track.thumb ? (
            <img key={track.id} src={upgradeArtwork(track.thumb, 200)} alt="" className="h-full w-full object-cover animate-art-in" draggable={false} />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <SpCoverNote />
            </span>
          )}
        </span>
        <span className="m-mini-meta animate-meta-in" key={`meta-${track.id}`}>
          <span className="block text-[14px] leading-[18px] font-semibold text-white">
            <FitText mode="auto" text={shortTitle(track.title)} full={track.title} />
          </span>
          <span className="block text-[12px] leading-[16px] text-[#b3b3b3]">
            <FitText mode="auto" text={track.artist} />
          </span>
        </span>
      </button>
      <div className="m-mini-ctl">
        <button className="m-tap m-mini-btn" onClick={prev} aria-label="Previous">
          <SkipBack className="h-5 w-5" fill="currentColor" />
        </button>
        <button className={`m-tap m-mini-play${buffering ? " is-loading" : ""}`} onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="h-5 w-5" fill="currentColor" /> : <Play className="h-5 w-5 translate-x-[1px]" fill="currentColor" />}
        </button>
        <button className="m-tap m-mini-btn" onClick={() => next(true)} aria-label="Next">
          <SkipForward className="h-5 w-5" fill="currentColor" />
        </button>
      </div>
      <div className="m-mini-bar" aria-hidden>
        <div className="m-mini-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BottomNav() {
  const view = useUI((s) => s.view.name);
  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const navigate = useUI((s) => s.navigate);
  const drawerOpen = useMobileUI((s) => s.drawerOpen);
  const setDrawer = useMobileUI((s) => s.setDrawer);
  const goHome = (): void => {
    useUI.setState({ lyricsCenter: false });
    navigate({ name: "home" });
  };
  const item = (id: string, label: string, icon: ReactNode, active: boolean, onClick: () => void) => (
    <button key={id} className={`m-tab m-tap${active ? " is-on" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="m-tab-ico">{icon}</span>
      <span className="m-tab-label">{label}</span>
    </button>
  );
  const onPage = (names: string[]): boolean => !drawerOpen && !lyricsCenter && names.includes(view);
  return (
    <nav className="m-nav" aria-label="Main">
      {item("home", "Home", <Home className="h-[22px] w-[22px]" />, onPage(["home"]), goHome)}
      {item("search", "Search", <Search className="h-[22px] w-[22px]" />, onPage(["search"]), () => {
        useUI.setState({ lyricsCenter: false });
        navigate({ name: "search" });
        window.setTimeout(() => (document.getElementById("global-search") as HTMLInputElement | null)?.focus(), 60);
      })}
      {item("library", "Library", <LibraryIcon className="h-[22px] w-[22px]" />, onPage(["library", "playlists", "playlist", "liked", "folder", "local", "downloads"]), () => {
        useUI.setState({ lyricsCenter: false });
        navigate({ name: "library" });
      })}
      {item("menu", "Menu", <MenuIcon className="h-[22px] w-[22px]" />, drawerOpen, () => setDrawer(!drawerOpen))}
    </nav>
  );
}

/** Slide-in panel holding the full "Your Library" sidebar (playlists, Liked, Downloads, Local music, Replay, ...). */
function Drawer() {
  const open = useMobileUI((s) => s.drawerOpen);
  const setDrawer = useMobileUI((s) => s.setDrawer);
  const view = useUI((s) => s.view);
  const firstView = useRef(view);
  // Choosing anything in the panel navigates; the panel then gets out of the way.
  useEffect(() => {
    if (view !== firstView.current) {
      firstView.current = view;
      setDrawer(false);
    }
  }, [view, setDrawer]);
  return (
    <div className={`m-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
      <div className="m-scrim" onClick={() => setDrawer(false)} />
      <div className="m-drawer-panel" role="dialog" aria-label="Menu">
        <div className="m-drawer-head">
          <span className="text-[17px] font-bold text-ink-hi">Menu</span>
          <button className="m-tap grid h-10 w-10 place-items-center rounded-full bg-white/[0.07]" onClick={() => setDrawer(false)} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="m-drawer-body">{open && <Sidebar />}</div>
      </div>
    </div>
  );
}

/** The right rail (queue / room) as a bottom sheet. */
function QueueSheet() {
  const panel = useUI((s) => s.rightPanel);
  const open = panel !== "details";
  const close = (): void => useUI.setState({ rightPanel: "details" });
  const startY = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  if (!open) return null;
  return (
    <div className="m-sheet-wrap">
      <div className="m-scrim" onClick={close} />
      <div
        className="m-sheet animate-pop-in"
        style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}
        role="dialog"
        aria-label={panel === "room" ? "Room" : "Queue"}
      >
        <div
          className="m-sheet-grab"
          onTouchStart={(e) => {
            startY.current = e.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(e) => {
            if (startY.current === null) return;
            setDy(Math.max(0, (e.touches[0]?.clientY ?? 0) - startY.current));
          }}
          onTouchEnd={() => {
            const far = dy > 110;
            startY.current = null;
            setDy(0);
            if (far) close();
          }}
        >
          <span />
        </div>
        <RightRail />
      </div>
    </div>
  );
}

export function MobileShell({ children, shellRef }: { children: ReactNode; shellRef: RefObject<HTMLDivElement> }) {
  const keyboard = useKeyboardOpen();
  const hasTrack = usePlayer((s) => !!shownTrack(s));
  return (
    <div ref={shellRef} className={`m-shell ambient-root text-ink select-none${keyboard ? " kb-open" : ""}${hasTrack ? " has-mini" : ""}`}>
      <TopBar />
      <div className="m-body">{children}</div>
      <MiniPlayer />
      <BottomNav />
      <Drawer />
      <QueueSheet />
      <NowPlaying />
      <Dialog />
      <FloatingWindows />
      <PlaylistPicker />
      <ContextMenu />
      <Toasts />
    </div>
  );
}



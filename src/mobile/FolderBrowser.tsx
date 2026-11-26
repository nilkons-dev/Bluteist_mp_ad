/**
 * In-app folder browser — Android's stand-in for the desktop "choose folder" dialog.
 * showFolderBrowser() resolves with the chosen absolute path, or null if dismissed.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUp, Check, ChevronRight, Folder, HardDrive, Music2, X } from "lucide-react";
import { invoke } from "./nodeLink";

interface Listing {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; audio: number }>;
  audioCount: number;
  readable: boolean;
}
interface Root {
  label: string;
  path: string;
}

function Browser({ onDone }: { onDone: (dir: string | null) => void }) {
  const [roots, setRoots] = useState<Root[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const open = useCallback(async (dir: string | null) => {
    setBusy(true);
    setError(null);
    try {
      if (dir === null) {
        setListing(null);
      } else {
        setListing(await invoke<Listing>("android:listDir", dir));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that folder");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const r = await invoke<Root[]>("android:storageRoots");
        setRoots(r);
        // Start where music usually is: Internal storage → Music, else the storage root itself.
        const internal = r[0];
        if (internal) {
          try {
            await open(`${internal.path}/Music`);
            return;
          } catch {
            /* fall through */
          }
          await open(internal.path);
        } else {
          setBusy(false);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Storage isn't available");
        setBusy(false);
      }
    })();
  }, [open]);

  const back = (): void => onDone(null);
  // Hardware back closes the browser (the shell's own back handler checks this flag first).
  useEffect(() => {
    const h = (): void => back();
    window.addEventListener("blutheist-folder-browser-close", h);
    (window as unknown as { __folderBrowserOpen?: boolean }).__folderBrowserOpen = true;
    return () => {
      window.removeEventListener("blutheist-folder-browser-close", h);
      (window as unknown as { __folderBrowserOpen?: boolean }).__folderBrowserOpen = false;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[400] flex flex-col justify-end bg-black/60 animate-fade-in" onClick={back}>
      <div
        className="m-folder-sheet flex max-h-[88vh] min-h-[55vh] flex-col rounded-t-3xl bg-elevated text-ink shadow-float animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-bold text-ink-hi">Choose a folder</div>
            <div className="truncate text-[12px] text-ink-faint">{listing ? listing.path : "Pick a storage"}</div>
          </div>
          <button onClick={back} aria-label="Close" className="m-tap grid h-10 w-10 place-items-center rounded-full bg-white/[0.06] active:bg-white/[0.12]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto px-4 pb-2 no-scrollbar">
          {roots.map((r) => (
            <button
              key={r.path}
              onClick={() => void open(r.path)}
              className="m-tap inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[13px] font-semibold active:bg-white/[0.14]"
            >
              <HardDrive className="h-4 w-4" /> {r.label}
            </button>
          ))}
          {listing?.parent && (
            <button onClick={() => void open(listing.parent)} className="m-tap inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-2 text-[13px] font-semibold active:bg-white/[0.14]">
              <ArrowUp className="h-4 w-4" /> Up
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {busy && <div className="px-4 py-6 text-[14px] text-ink-faint">Loading…</div>}
          {error && <div className="px-4 py-6 text-[14px] text-ink-faint">{error}</div>}
          {!busy && listing && !listing.readable && (
            <div className="px-4 py-6 text-[14px] text-ink-faint">Blutheist can't read this folder. Allow music access in the system prompt, or pick another folder.</div>
          )}
          {!busy &&
            listing?.dirs.map((d) => (
              <button key={d.path} onClick={() => void open(d.path)} className="m-tap flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-white/[0.08]">
                <Folder className="h-5 w-5 shrink-0 text-ink-dim" />
                <span className="min-w-0 flex-1 truncate text-[15px]">{d.name}</span>
                {d.audio > 0 && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-ink-faint">
                    <Music2 className="h-3.5 w-3.5" />
                    {d.audio}
                  </span>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-ghost" />
              </button>
            ))}
          {!busy && listing && listing.readable && listing.dirs.length === 0 && (
            <div className="px-4 py-6 text-[14px] text-ink-faint">No subfolders here.</div>
          )}
        </div>

        <div className="m-safe-bottom flex items-center gap-3 border-t border-white/10 px-4 py-3">
          <div className="min-w-0 flex-1 text-[13px] text-ink-dim">{listing ? `${listing.audioCount} song${listing.audioCount === 1 ? "" : "s"} in this folder` : ""}</div>
          <button
            disabled={!listing}
            onClick={() => listing && onDone(listing.path)}
            className="m-tap inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[15px] font-bold text-on-primary disabled:opacity-40 active:scale-95"
          >
            <Check className="h-5 w-5" /> Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

let active: Promise<string | null> | null = null;

export function showFolderBrowser(): Promise<string | null> {
  if (active) return active;
  active = new Promise<string | null>((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const finish = (dir: string | null): void => {
      root.unmount();
      host.remove();
      active = null;
      resolve(dir);
    };
    root.render(<Browser onDone={finish} />);
  });
  return active;
}

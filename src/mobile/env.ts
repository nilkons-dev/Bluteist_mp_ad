/** Android environment detection + device performance tier. Safe to import anywhere (no side effects). */
import { Capacitor } from "@capacitor/core";

export const isAndroid: boolean = (() => {
  try {
    return Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
})();

export type PerfTier = "low" | "mid" | "high";
export type PerfPref = "auto" | PerfTier;
const PERF_KEY = "blutheist.perf";

/** Rough device class from what the WebView exposes. Low = 2 GB-class phones, mid = 3–4 GB, high = the rest. */
export function detectTier(): PerfTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : 4;
  const cores = navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  if (mem <= 2 || (mem <= 3 && cores <= 4) || cores <= 2) return "low";
  if (mem <= 4 || cores <= 6) return "mid";
  return "high";
}

export function getPerfPref(): PerfPref {
  try {
    const v = localStorage.getItem(PERF_KEY);
    return v === "low" || v === "mid" || v === "high" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setPerfPref(p: PerfPref): void {
  try {
    if (p === "auto") localStorage.removeItem(PERF_KEY);
    else localStorage.setItem(PERF_KEY, p);
  } catch {
    /* storage unavailable: the choice just doesn't persist */
  }
  applyPerf();
}

export function effectiveTier(): PerfTier {
  const p = getPerfPref();
  return p === "auto" ? detectTier() : p;
}

/** Puts perf-low / perf-mid / perf-high on <html>; mobile.css trims only the costliest GPU effects on low. */
export function applyPerf(): PerfTier {
  const tier = effectiveTier();
  const cl = document.documentElement.classList;
  cl.remove("perf-low", "perf-mid", "perf-high");
  cl.add(`perf-${tier}`);
  return tier;
}

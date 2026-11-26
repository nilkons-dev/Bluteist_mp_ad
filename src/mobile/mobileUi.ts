/** Mobile-only UI state (drawer, "more" sheet, queue sheet). Kept out of the shared UI store on purpose. */
import { create } from "zustand";

interface MobileUI {
  drawerOpen: boolean;
  setDrawer(open: boolean): void;
  /** true while the full-screen search field is focused (hides the bottom nav so the keyboard has room) */
  searchFocused: boolean;
  setSearchFocused(v: boolean): void;
}

export const useMobileUI = create<MobileUI>((set) => ({
  drawerOpen: false,
  setDrawer: (drawerOpen) => set({ drawerOpen }),
  searchFocused: false,
  setSearchFocused: (searchFocused) => set({ searchFocused }),
}));

import { create } from "zustand";

interface UIState {
  searchOpen: boolean;
  mobileMenuOpen: boolean;
  shortcutsHelpOpen: boolean;
  installPrompt: any | null;
  setSearchOpen: (v: boolean) => void;
  setMobileMenuOpen: (v: boolean) => void;
  setShortcutsHelpOpen: (v: boolean) => void;
  setInstallPrompt: (v: any | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  mobileMenuOpen: false,
  shortcutsHelpOpen: false,
  installPrompt: null,
  setSearchOpen: (v) => set({ searchOpen: v }),
  setMobileMenuOpen: (v) => set({ mobileMenuOpen: v }),
  setShortcutsHelpOpen: (v) => set({ shortcutsHelpOpen: v }),
  setInstallPrompt: (v) => set({ installPrompt: v }),
}));

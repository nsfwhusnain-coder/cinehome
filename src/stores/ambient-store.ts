import { create } from "zustand";

interface AmbientState {
  color: string | null;
  setColor: (color: string | null) => void;
}

export const useAmbientStore = create<AmbientState>((set) => ({
  color: null,
  setColor: (color) => set({ color }),
}));

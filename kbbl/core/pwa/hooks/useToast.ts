import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  expiresAt: number;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (opts: { kind: ToastKind; message: string; ttlMs?: number }) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],

  pushToast: ({ kind, message, ttlMs = 4000 }) => {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + ttlMs;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message, expiresAt }] }));
    setTimeout(() => get().dismissToast(id), ttlMs);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

export function useToast() {
  const toasts = useToastStore((s) => s.toasts);
  const pushToast = useToastStore((s) => s.pushToast);
  const dismissToast = useToastStore((s) => s.dismissToast);
  return { toasts, pushToast, dismissToast };
}

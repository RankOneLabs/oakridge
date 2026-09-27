import { create } from "zustand";

import { randomUuid } from "../lib/random-uuid";
import type { SessionSnapshot } from "../types";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  href: string | null;
  expiresAt: number;
}

export interface ToastInput {
  readonly kind: ToastKind;
  readonly message: string;
  readonly href?: string;
  readonly ttlMs?: number;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (opts: ToastInput) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],

  pushToast: ({ kind, message, href = null, ttlMs = 4000 }) => {
    const id = randomUuid();
    const expiresAt = Date.now() + ttlMs;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message, href, expiresAt }] }));
    setTimeout(() => get().dismissToast(id), ttlMs);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Toast only the upward edge; the PendingApprovalsBadge remains the durable surface. */
export const selectPendingPermissionToasts = (
  previous: readonly SessionSnapshot[],
  incoming: readonly SessionSnapshot[],
): readonly ToastInput[] => {
  const previousCounts = new Map(previous.map((snapshot) => [snapshot.sid, snapshot.pendingPermissionCount]));
  return incoming
    .filter((snapshot) => snapshot.pendingPermissionCount > (previousCounts.get(snapshot.sid) ?? 0))
    .map((snapshot) => ({
      kind: "info" as const,
      message: `${snapshot.pendingPermissionCount} approval${snapshot.pendingPermissionCount === 1 ? "" : "s"} pending · ${snapshot.name || snapshot.sid.slice(0, 8)}`,
      href: `#sid=${encodeURIComponent(snapshot.sid)}&focus=pending-permission`,
    }));
};

export function useToast() {
  const toasts = useToastStore((s) => s.toasts);
  const pushToast = useToastStore((s) => s.pushToast);
  const dismissToast = useToastStore((s) => s.dismissToast);
  return { toasts, pushToast, dismissToast };
}

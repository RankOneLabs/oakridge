import { useToast } from "../../hooks/useToast";
import { ToastItem } from "../atoms/ToastItem";

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();

  return (
    <div
      className="toast-viewport"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

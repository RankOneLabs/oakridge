import type { Toast } from "../../hooks/useToast";

interface Props {
  toast: Toast;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: Props) {
  return (
    <div className={`toast-item toast-item--${toast.kind}`} role="alert">
      <span>{toast.message}</span>
      <button
        className="toast-item__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

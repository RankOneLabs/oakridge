import type { Toast } from "../../hooks/useToast";

interface Props {
  toast: Toast;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: Props) {
  return (
    <div className={`toast-item toast-item--${toast.kind}`} role="status">
      {toast.href === null ? (
        <span>{toast.message}</span>
      ) : (
        <a className="toast-item__link" href={toast.href}>{toast.message}</a>
      )}
      <button
        type="button"
        className="toast-item__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

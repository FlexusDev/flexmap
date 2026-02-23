import { useAppStore } from "../../store/useAppStore";
import type { Toast } from "../../store/useAppStore";

const TYPE_STYLES: Record<Toast["type"], string> = {
  error: "bg-red-900/90 border-red-500/50 text-red-100",
  warning: "bg-amber-900/90 border-amber-500/50 text-amber-100",
  info: "bg-blue-900/90 border-blue-500/50 text-blue-100",
};

const TYPE_ICONS: Record<Toast["type"], string> = {
  error: "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z",
  warning: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  info: "M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z",
};

function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-10 left-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            pointer-events-auto
            flex items-center gap-2 px-3 py-2
            rounded-lg border shadow-lg backdrop-blur-sm
            text-xs font-medium
            animate-toastIn
            max-w-sm
            ${TYPE_STYLES[toast.type]}
          `}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-shrink-0 opacity-80"
          >
            <path d={TYPE_ICONS[toast.type]} />
          </svg>
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => dismissToast(toast.id)}
            className="ml-1 opacity-50 hover:opacity-100 transition-opacity"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(-20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .animate-toastIn {
          animation: toastIn 0.2s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

export default ToastContainer;

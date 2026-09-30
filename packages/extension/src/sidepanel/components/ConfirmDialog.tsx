import { useEffect, useRef, useState } from "preact/hooks";

export interface ConfirmRequest {
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

let openDialog: ((req: Pending) => void) | null = null;

/** Accessible modal confirmation (native <dialog>: focus trap, Escape = cancel). */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (openDialog) openDialog({ ...req, resolve });
    else resolve(window.confirm(`${req.title}\n\n${req.message}`));
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<Pending | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const reqRef = useRef<Pending | null>(null);
  reqRef.current = req;

  useEffect(() => {
    openDialog = (r) => {
      reqRef.current?.resolve(false);
      setReq(r);
    };
    return () => {
      openDialog = null;
    };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (req && d && !d.open) d.showModal();
  }, [req]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      finish(false);
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  });

  const finish = (ok: boolean) => {
    const current = reqRef.current;
    ref.current?.close();
    setReq(null);
    current?.resolve(ok);
  };

  return (
    <dialog ref={ref} class="dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      {req && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            finish(true);
          }}
        >
          <h2 id="confirm-title">{req.title}</h2>
          <p id="confirm-message">{req.message}</p>
          {req.details && req.details.length > 0 && (
            <ul class="plain-list">
              {req.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          <div class="row end">
            <button type="button" class="btn" autoFocus onClick={() => finish(false)}>
              {req.cancelLabel ?? "Abbrechen"}
            </button>
            <button type="submit" class={req.danger ? "btn danger" : "btn primary"}>
              {req.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

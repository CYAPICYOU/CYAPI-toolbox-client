import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import './primitives.css';

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
  dismissWhileBusy = false,
  className = '',
  descriptionId,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
  /** Keeps the dialog closable while `busy`, so a task can move to the background. */
  dismissWhileBusy?: boolean;
  className?: string;
  descriptionId?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const dismissRef = useRef(dismissWhileBusy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  dismissRef.current = dismissWhileBusy;
  const locked = busy && !dismissWhileBusy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    node?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(busyRef.current && !dismissRef.current)) {
        onCloseRef.current();
      }
      if (event.key !== 'Tab' || !node) return;
      const focusables = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusables.length) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === node)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''} ${className}`}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={locked}
            aria-label="关闭对话框"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function RestartPrompt({
  target,
  onClose,
  children,
}: {
  target: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <Modal
      title={
        <>
          <span className="n-restart-success" aria-hidden="true">
            <Check size={18} strokeWidth={2.4} />
          </span>
          配置已保存
        </>
      }
      onClose={onClose}
      className="n-restart-dialog"
      descriptionId={descriptionId}
    >
      <div className="n-restart-body" id={descriptionId}>
        {children ?? (
          <>
            <p>请完全关闭 {target}。</p>
            <p>重新打开后，新配置即可生效。</p>
          </>
        )}
      </div>
      <div className="n-dialog-footer">
        <button type="button" className="n-button n-primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </Modal>
  );
}

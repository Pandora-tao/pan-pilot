import { X } from "lucide-react";
import { gsap } from "gsap";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { withMotion } from "../animations";

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 是否允许用户主动关闭（X 按钮 / Escape / 点击遮罩）；默认 true。 */
  closable?: boolean;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  closable = true,
}: ModalProps) {
  const panelRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (!backdrop || !panel) return;
    return withMotion(() => {
      gsap.fromTo(
        backdrop,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.16, ease: "power2.out" },
      );
      gsap.fromTo(
        panel,
        { autoAlpha: 0, y: 14, scale: 0.98 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.28,
          ease: "power3.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (closable && event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closable, onClose, open]);

  if (!open) return null;
  return (
    <div
      ref={backdropRef}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={closable ? onClose : undefined}
    >
      <section
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 id="modal-title">{title}</h2>
          {closable && (
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
              <X aria-hidden="true" size={19} />
            </button>
          )}
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-actions">{footer}</div>}
      </section>
    </div>
  );
}

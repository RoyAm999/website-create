"use client";

import type { ReactNode } from "react";

export function Spinner({ label = "טוענים את Shuv Flow…" }: { label?: string }) {
  return (
    <div className="state-screen" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ onRetry, compact = false }: { onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={compact ? "inline-state inline-state--error" : "state-screen state-screen--error"} role="alert">
      <span className="state-icon" aria-hidden="true">!</span>
      <div>
        <h2>משהו לא נטען כמו שצריך.</h2>
        <p>לא נשלחה שום הודעה והמידע שלכם נשמר.</p>
      </div>
      {onRetry && <button className="button button--secondary" onClick={onRetry}>נסה שוב</button>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="empty-state">
      <span className="empty-state__mark" aria-hidden="true">✓</span>
      <h2>{title}</h2>
      <div className="muted-copy">{children}</div>
      {action && <div className="empty-state__action">{action}</div>}
    </section>
  );
}

export function Notice({ children, tone = "sage" }: { children: ReactNode; tone?: "sage" | "warning" | "success" }) {
  return <div className={`notice notice--${tone}`}>{children}</div>;
}

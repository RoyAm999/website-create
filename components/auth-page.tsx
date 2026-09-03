import { Suspense, type ReactNode } from "react";
import { Logo } from "./logo";

export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <aside className="auth-aside">
        <Logo />
        <div>
          <p className="auth-quote">“לא לחזור לכל הפניות.<br />לחזור לפניות הנכונות.”</p>
          <div className="auth-rule"><span>✓</span><p><strong>שום הודעה לא נשלחת לבד.</strong><br />הצוות רואה, מבין ומאשר.</p></div>
        </div>
      </aside>
      <section className="auth-panel">
        <Suspense fallback={<div className="state-screen">טוענים…</div>}>{children}</Suspense>
      </section>
    </main>
  );
}

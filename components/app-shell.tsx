"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { clearStoredSupabaseSession, getSupabase } from "@/lib/supabase";
import { reportClientError } from "@/lib/report-error";
import { Logo } from "./logo";
import { useWorkspace, WorkspaceGate } from "./workspace-gate";

const nav = [
  { href: "/app/today/", label: "היום", icon: "today" },
  { href: "/app/leads/", label: "פניות", icon: "leads" },
  { href: "/app/results/", label: "תוצאות", icon: "results" },
] as const;

function NavIcon({ name }: { name: string }) {
  if (name === "leads") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2.5 19v-2.2A5.3 5.3 0 0 1 7.8 11.5h.4a5.3 5.3 0 0 1 5.3 5.3V19M14 12.2c.7-.4 1.5-.7 2.4-.7h.2a4.9 4.9 0 0 1 4.9 4.9V19"/></svg>;
  if (name === "results") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m6 10V4m6 15v-7m4 7H2"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.4-6.4L17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6"/><circle cx="12" cy="12" r="4"/></svg>;
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { clinic } = useWorkspace();
  const [offline, setOffline] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const { error } = await Promise.race([
        getSupabase().auth.signOut({ scope: "local" }),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("SIGN_OUT_TIMEOUT")), 9000)),
      ]);
      if (error) throw error;
      router.replace("/login/");
    } catch (signOutError) {
      reportClientError("auth.signout", signOutError);
      // Do not queue a second sign-out behind a request that may be holding the
      // SDK auth lock. Clear only this app's storage and reload the public
      // login route so a failed network revoke can never trap the operator.
      clearStoredSupabaseSession();
      window.location.replace("/login/");
    }
  }

  return (
    <div className="app-root">
      {offline && <div className="offline-banner" role="status">אין כרגע חיבור לאינטרנט. הישארו במסך ונסו שוב אחרי שהחיבור יחזור.</div>}
      <header className="app-header">
        <div className="app-header__inner">
          <Logo href="/app/today/" compact />
          <div className="clinic-identity">
            <span>{clinic?.clinic_name}</span>
            <button type="button" onClick={signOut} disabled={signingOut}>{signingOut ? "יוצאים…" : "יציאה"}</button>
          </div>
        </div>
      </header>

      <div className="app-layout">
        <aside className="side-nav" aria-label="ניווט ראשי">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href.slice(0, -1) || pathname === item.href ? "active" : ""} aria-current={pathname === item.href.slice(0, -1) || pathname === item.href ? "page" : undefined}>
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
          <p className="side-nav__promise">אין סיבה.<br />אין הודעה.</p>
        </aside>
        <main className="app-main" id="main-content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="ניווט ראשי">
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className={pathname === item.href.slice(0, -1) || pathname === item.href ? "active" : ""} aria-current={pathname === item.href.slice(0, -1) || pathname === item.href ? "page" : undefined}>
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <WorkspaceGate><Shell>{children}</Shell></WorkspaceGate>;
}

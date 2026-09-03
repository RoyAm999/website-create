"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { friendlyError, getSupabase } from "@/lib/supabase";
import { reportClientError } from "@/lib/report-error";

function withAuthTimeout<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("AUTH_TIMEOUT")), 12000);
    request.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const client = getSupabase();
      if (mode === "signup") {
        const { data, error: authError } = await withAuthTimeout(client.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/onboarding/` },
        }));
        if (authError) throw authError;
        if (!data.session) {
          if (mountedRef.current) setConfirmation(true);
          return;
        }
        router.replace("/onboarding/");
      } else {
        const { error: authError } = await withAuthTimeout(client.auth.signInWithPassword({ email: email.trim(), password }));
        if (authError) throw authError;
        const next = search.get("next");
        router.replace(next?.startsWith("/app/") ? next : "/app/today/");
      }
    } catch (authError) {
      reportClientError(`auth.${mode}`, authError);
      if (mountedRef.current) {
        setError(authError instanceof Error && authError.message === "AUTH_TIMEOUT"
          ? "החיבור לוקח יותר מדי זמן. בדקו את הרשת ונסו שוב."
          : friendlyError(authError));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  if (confirmation) {
    return (
      <div className="auth-confirmation" role="status">
        <span>✓</span>
        <h1>נשאר רק לאשר את האימייל.</h1>
        <p>שלחנו קישור ל־<bdi dir="ltr">{email}</bdi>. אחרי האישור תחזרו ישר להגדרת המרפאה.</p>
        <Link href="/login/" className="button">כבר אישרתי — כניסה</Link>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      <div className="auth-heading">
        <p className="eyebrow"><span /> {mode === "signup" ? "מתחילים בפשטות" : "טוב לראות אתכם"}</p>
        <h1>{mode === "signup" ? "פתיחת סביבת ניסיון" : "כניסה ל־Shuv Flow"}</h1>
        <p>{mode === "signup" ? "אחרי פתיחת החשבון נעלה יחד את הפניות הראשונות." : "המשיכו בדיוק מהמקום שבו עצרתם."}</p>
      </div>

      <label>
        <span>אימייל</span>
        <input type="email" inputMode="email" dir="ltr" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="name@clinic.co.il" />
      </label>
      <label>
        <span>סיסמה</span>
        <input type="password" dir="ltr" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="לפחות 8 תווים" />
      </label>

      {error && <div ref={errorRef} className="form-error" role="alert" tabIndex={-1}>{error}</div>}
      <button className="button button--wide" type="submit" disabled={busy || !email || password.length < 8}>
        {busy ? "רגע…" : mode === "signup" ? "פתיחת חשבון" : "כניסה"}
      </button>
      <p className="auth-switch">
        {mode === "signup" ? "כבר יש חשבון?" : "עדיין אין חשבון?"}{" "}
        <Link href={mode === "signup" ? "/login/" : "/signup/"}>{mode === "signup" ? "כניסה" : "פתיחת סביבת ניסיון"}</Link>
      </p>
    </form>
  );
}

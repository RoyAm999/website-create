"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { bootstrapClinic, currentWorkspace, ensureDueRequestedContactMatches, finishOnboarding, importLeads, loadDemoLeads } from "@/lib/data";
import { csvImportErrorMessage, parseCsv } from "@/lib/csv";
import { friendlyError, getSupabase, isAuthSessionError } from "@/lib/supabase";
import { reportClientError } from "@/lib/report-error";
import type { Lead } from "@/lib/types";
import { Logo } from "./logo";
import { ErrorState, Spinner } from "./ui";

type Insight = { label: string; count: number };
type Example = { name: string; reason: string };
type Summary = {
  total: number;
  dnc: number;
  needsFix: number;
  ready: number;
  priority: number;
  changeId?: string;
  demo: boolean;
  insights: Insight[];
  examples: Example[];
};

const insightLabels: Record<string, string> = {
  timing: "שעה או יום לא התאימו",
  availability: "לא הייתה זמינות מתאימה",
  service: "השירות לא היה זמין",
  payment: "אפשרות התשלום לא התאימה",
  requested_date: "ביקשו שנחזור במועד מסוים",
  needs_time: "ביקשו זמן לחשוב",
  no_response: "לא התקבלה תשובה",
  price: "המחיר לא התאים",
  competitor: "בחרו מקום אחר",
  not_interested: "לא היה עניין",
  unknown: "לא ידוע למה נעצרו",
};

function summarize(leads: Lead[], priority: number, changeId: string | undefined, demo: boolean): Summary {
  const reasonCounts = new Map<string, number>();
  for (const lead of leads) {
    const key = lead.stopped_reason_code || "unknown";
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }
  const insights = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, count]) => ({ label: insightLabels[key] || "סיבה אחרת", count }));
  const examples = leads
    .filter((lead) => !lead.dnc && lead.stopped_reason_text && lead.stopped_reason_code !== "unknown")
    .slice(0, 3)
    .map((lead) => ({ name: lead.name, reason: lead.stopped_reason_text }));

  return {
    total: leads.length,
    dnc: leads.filter((lead) => lead.dnc).length,
    needsFix: leads.filter((lead) => lead.needs_fix || lead.medical_escalation || lead.stopped_reason_code === "unknown").length,
    ready: leads.filter((lead) => !lead.dnc && !lead.medical_escalation && !lead.needs_fix && lead.stopped_reason_code !== "unknown").length,
    priority,
    changeId,
    demo,
    insights,
    examples,
  };
}

export function Onboarding() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [clinicName, setClinicName] = useState("");
  const [mainService, setMainService] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const client = getSupabase();
      const { data } = await Promise.race([
        client.auth.getSession(),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("SESSION_TIMEOUT")), 9000)),
      ]);
      if (!data.session) {
        router.replace("/login/?next=/onboarding/");
        return;
      }
      const context = await Promise.race([
        currentWorkspace(client),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("WORKSPACE_TIMEOUT")), 9000)),
      ]);
      if (context?.clinic?.onboarding_completed) {
        router.replace("/app/today/");
        return;
      }
      if (context?.clinic) {
        setClinicName(context.clinic.clinic_name);
        setMainService(context.clinic.main_service);
        setOrganizationId(context.organizationId);
        setStep(2);
      }
      setReady(true);
    } catch (sessionError) {
      reportClientError("onboarding.session", sessionError);
      if (isAuthSessionError(sessionError)) {
        await getSupabase().auth.signOut({ scope: "local" });
        router.replace("/login/?next=/onboarding/");
        return;
      }
      setError("לא הצלחנו לפתוח את ההגדרה.");
      setReady(true);
    }
  }, [router]);

  useEffect(() => {
    void checkSession();
    const client = getSupabase();
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.replace("/login/?next=/onboarding/");
    });
    return () => data.subscription.unsubscribe();
  }, [checkSession, router]);

  async function saveClinic(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const context = await bootstrapClinic(getSupabase(), clinicName, mainService);
      setOrganizationId(context.organizationId);
      setStep(2);
    } catch (saveError) {
      reportClientError("onboarding.clinic", saveError);
      setError(friendlyError(saveError));
    } finally { setBusy(false); }
  }

  async function useDemo() {
    if (!organizationId) return;
    setBusy(true);
    setError("");
    try {
      const leads = await loadDemoLeads(getSupabase(), organizationId);
      const firstAction = await ensureDueRequestedContactMatches(getSupabase(), organizationId, leads);
      setSummary(summarize(leads, firstAction?.count || 0, firstAction?.changeId, true));
      setStep(3);
    } catch (loadError) { reportClientError("onboarding.demo", loadError, organizationId); setError(friendlyError(loadError)); }
    finally { setBusy(false); }
  }

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !organizationId) return;
    setBusy(true);
    setError("");
    try {
      const parsed = parseCsv(await file.text(), mainService);
      const leads = await importLeads(getSupabase(), organizationId, [...parsed.valid, ...parsed.needsFix]);
      const firstAction = await ensureDueRequestedContactMatches(getSupabase(), organizationId, leads);
      setSummary(summarize(leads, firstAction?.count || 0, firstAction?.changeId, false));
      setStep(3);
    } catch (fileError) {
      reportClientError("onboarding.import", fileError, organizationId);
      setError(csvImportErrorMessage(fileError) || friendlyError(fileError));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function enterProduct() {
    setBusy(true);
    try {
      await finishOnboarding(getSupabase(), organizationId);
      router.replace(summary?.changeId
        ? `/app/today/?matches=${encodeURIComponent(summary.changeId)}&welcome=1`
        : "/app/today/?welcome=1");
    } catch (finishError) { reportClientError("onboarding.finish", finishError, organizationId); setError(friendlyError(finishError)); setBusy(false); }
  }

  if (!ready) return <Spinner />;
  if (error && !organizationId && step === 1) return <ErrorState onRetry={checkSession} />;

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Logo compact /><span>הגדרה ראשונית</span></header>
      <div className="onboarding-progress" aria-label={`שלב ${step} מתוך 3`}><span className={step >= 1 ? "done" : ""} /><span className={step >= 2 ? "done" : ""} /><span className={step >= 3 ? "done" : ""} /></div>

      {step === 1 && (
        <form className="onboarding-card" onSubmit={saveClinic}>
          <p className="step-kicker">שלב 1 מתוך 3</p>
          <h1>בואו נראה אילו פניות עוד שוות כסף.</h1>
          <p>שם המרפאה והשירות העיקרי. אחר כך מעלים את הפניות שלא נסגרו.</p>
          <label><span>שם המרפאה</span><input value={clinicName} onChange={(event) => setClinicName(event.target.value)} required autoFocus placeholder="למשל: קליניקת נועה" /></label>
          <label><span>השירות העיקרי</span><input value={mainService} onChange={(event) => setMainService(event.target.value)} required placeholder="למשל: טיפול פנים" /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button--wide" disabled={busy || clinicName.trim().length < 2 || mainService.trim().length < 2}>{busy ? "שומרים…" : "המשך לפניות שלא נסגרו"}</button>
        </form>
      )}

      {step === 2 && (
        <section className="onboarding-card upload-card">
          <p className="step-kicker">שלב 2 מתוך 3</p>
          <h1>העלו את הפניות שלא נסגרו.</h1>
          <p>Shuv Flow יסדר למה הן נעצרו, מה חסר במידע, ומי בכלל יכולה להיות רלוונטית לחזרה בעתיד.</p>
          <input ref={fileRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={pickFile} />
          <button type="button" className="upload-drop" onClick={() => fileRef.current?.click()} disabled={busy}>
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>{busy ? "בודקים את הפניות…" : "בחירת קובץ CSV"}</strong>
            <small>שום הודעה לא נשלחת</small>
          </button>
          <div className="or-divider"><span>או</span></div>
          <button type="button" className="button button--secondary button--wide" onClick={useDemo} disabled={busy}>טענו 20 פניות לדוגמה</button>
          <a className="sample-link" href="/sample-leads.csv" download>הורדת קובץ לדוגמה</a>
          {error && <div className="form-error" role="alert">{error}</div>}
        </section>
      )}

      {step === 3 && summary && (
        <section className="onboarding-card import-success">
          <span className="success-seal">✓</span>
          <p className="step-kicker">שלב 3 מתוך 3 · הנה מה למדנו</p>
          <h1>{summary.total} פניות נקלטו</h1>
          {summary.demo && <span className="demo-badge">פניות לדוגמה</span>}
          <div className="import-counts">
            <div><strong>{summary.dnc}</strong><span>לא ליצור קשר</span></div>
            <div><strong>{summary.needsFix}</strong><span>חסר מידע ברור</span></div>
            <div><strong>{summary.ready}</strong><span>מוכנות למעקב</span></div>
          </div>

          <section className="import-insights" aria-label="למה הפניות נעצרו">
            <header><span>מה למדנו</span><h2>למה הפניות נעצרו?</h2></header>
            <div>
              {summary.insights.length ? summary.insights.map((insight) => (
                <article key={insight.label}><strong>{insight.count}</strong><span>{insight.label}</span></article>
              )) : <p>עדיין אין מספיק מידע כדי לזהות דפוס ברור.</p>}
            </div>
          </section>

          {summary.examples.length > 0 && (
            <section className="import-examples" aria-label="דוגמאות מהפניות">
              <span>דוגמאות מהשיחות</span>
              {summary.examples.map((example) => (
                <p key={`${example.name}-${example.reason}`}><strong>{example.name}</strong><span>“{example.reason}”</span></p>
              ))}
            </section>
          )}

          {summary.priority > 0 ? (
            <div className="import-priority" role="status">
              <strong>{summary.priority}</strong>
              <p><b>{summary.priority === 1 ? "ויש פנייה אחת ששווה לבדוק עכשיו." : `ויש ${summary.priority} פניות ששווה לבדוק עכשיו.`}</b><br />המועד שביקשו שנחזור הגיע. מיד תראו מה היה אז, מה השתנה ולמה נכון לבדוק היום.</p>
            </div>
          ) : (
            <div className="import-promise"><span>✓</span><p><strong>כרגע אין סיבה טובה לפנות לאף אחד.</strong><br />וזה בדיוק העניין: לא שולחים “עדיין רלוונטי?” סתם. כשמשהו אמיתי ישתנה — המערכת תמצא למי הוא רלוונטי.</p></div>
          )}

          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button--wide" onClick={enterProduct} disabled={busy}>{busy ? "נכנסים…" : summary.priority > 0 ? summary.priority === 1 ? "הראו לי למה שווה לחזור אליה" : `הראו לי את ה־${summary.priority}` : "המשך למסך היום"}</button>
        </section>
      )}
    </main>
  );
}

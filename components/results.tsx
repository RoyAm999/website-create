"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { listOutcomes } from "@/lib/data";
import { reportClientError } from "@/lib/report-error";
import { summarizeResults } from "@/lib/results-summary";
import { friendlyError, getSupabase } from "@/lib/supabase";
import type { Outcome } from "@/lib/types";
import { useWorkspace } from "./workspace-gate";
import { EmptyState, ErrorState, Notice, Spinner } from "./ui";

function outcomeStage(outcome: Outcome) {
  if (outcome.revenue_confirmed_at) return "הכנסה אושרה";
  if (outcome.closed_at) return "נסגר";
  if (outcome.booked_at) return "נקבע תור";
  return "התקבלה התעניינות";
}

function DemoResultRows({ outcomes }: { outcomes: Outcome[] }) {
  return (
    <div className="result-list">
      {outcomes.map((outcome) => (
        <article key={outcome.id}>
          <span className="avatar">{outcome.lead?.name?.slice(0, 1) || "ד"}</span>
          <div>
            <h3>{outcome.lead?.name || "פניית דוגמה"}</h3>
            <p>{outcome.lead?.service || "שירות לדוגמה"}</p>
            <small>{outcomeStage(outcome)} · תרגול בלבד</small>
          </div>
          <span className="demo-badge">דוגמה</span>
        </article>
      ))}
    </div>
  );
}

function RealResultRow({
  outcome,
  organizationId,
  onCorrected,
}: {
  outcome: Outcome;
  organizationId: string;
  onCorrected: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(() => String((outcome.revenue_minor ?? 0) / 100));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmedRevenue = outcome.revenue_confirmed_at !== null;

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedAmount = Number(amount.replace(",", "."));
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("צריך להזין סכום חיובי בשקלים.");
      return;
    }
    if (reason.trim().length < 4) {
      setError("צריך לציין בקצרה למה הסכום מתוקן.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const { error: correctionError } = await getSupabase().rpc("sf_correct_recovered_revenue", {
        p_organization_id: organizationId,
        p_outcome_id: outcome.id,
        p_revenue_minor: Math.round(parsedAmount * 100),
        p_reason: reason.trim(),
      });
      if (correctionError) throw correctionError;
      setEditing(false);
      setReason("");
      await onCorrected();
    } catch (correctionError) {
      reportClientError("results.revenue.correct", correctionError, organizationId);
      setError(friendlyError(correctionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article>
      <span className="avatar">{outcome.lead?.name?.slice(0, 1) || "פ"}</span>
      <div>
        <h3>{outcome.lead?.name || "פנייה"}</h3>
        <p>{outcome.lead?.service || "שירות לא צוין"}</p>
        <small>{outcomeStage(outcome)}</small>
        {confirmedRevenue && !editing ? (
          <button className="text-button text-button--inline" type="button" onClick={() => setEditing(true)}>
            תיקון סכום
          </button>
        ) : null}
        {editing ? (
          <form className="reason-editor" onSubmit={submitCorrection}>
            <p>הסכום הנוכחי: <bdi dir="ltr">₪&nbsp;{Math.round((outcome.revenue_minor ?? 0) / 100).toLocaleString("he-IL")}</bdi></p>
            <label>
              <span>הסכום הנכון בשקלים</span>
              <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} autoFocus />
            </label>
            <label>
              <span>סיבת התיקון</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="למשל: טעות הקלדה" />
            </label>
            <p>התיקון יישמר ביומן הפעילות יחד עם הסכום הקודם.</p>
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <div className="form-actions">
              <button className="button" type="submit" disabled={busy}>{busy ? "שומרים…" : "שמירת תיקון מתועד"}</button>
              <button className="button button--secondary" type="button" onClick={() => { setEditing(false); setError(""); }} disabled={busy}>ביטול</button>
            </div>
          </form>
        ) : null}
      </div>
      <strong>{confirmedRevenue ? <bdi dir="ltr">₪&nbsp;{Math.round((outcome.revenue_minor ?? 0) / 100).toLocaleString("he-IL")}</bdi> : null}</strong>
    </article>
  );
}

export function Results() {
  const search = useSearchParams();
  const { organizationId } = useWorkspace();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setOutcomes(await listOutcomes(getSupabase(), organizationId));
      setStatus("ready");
    } catch (loadError) {
      reportClientError("results.load", loadError, organizationId);
      setStatus("error");
    }
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeResults(outcomes), [outcomes]);

  const handleCorrected = useCallback(async () => {
    setNotice("הסכום תוקן ונשמר ביומן הפעילות.");
    await load();
  }, [load]);

  if (status === "loading") return <Spinner label="מסכמים את התוצאות…" />;
  if (status === "error") return <ErrorState onRetry={load} />;
  return (
    <div className="results-page">
      <header className="list-heading"><div><p>תוצאות המרפאה</p><h1>מה חזר בפועל?</h1></div></header>
      {search.get("recovered") ? <Notice tone="success">האישור נשמר. הכנסה אמיתית נספרת רק לאחר אישור ידני; נתוני דוגמה אינם נספרים.</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <section className="funnel" aria-label="משפך תוצאות אמיתיות">
        <div><span>חזרו לשיחה</span><strong>{summary.funnel.returned}</strong></div>
        <i aria-hidden="true">←</i>
        <div><span>נקבע תור</span><strong>{summary.funnel.booked}</strong></div>
        <i aria-hidden="true">←</i>
        <div><span>נסגר</span><strong>{summary.funnel.closed}</strong></div>
        <i aria-hidden="true">←</i>
        <div className="funnel__revenue"><span>הכנסה שאושרה</span><strong><bdi dir="ltr">₪&nbsp;{Math.round(summary.funnel.revenue / 100).toLocaleString("he-IL")}</bdi></strong></div>
      </section>
      <p className="manual-revenue-note"><span>✓</span> הכנסה מופיעה רק אחרי אישור ידני של הצוות — היא לא מוערכת אוטומטית.</p>
      <section className="result-list-section">
        <header><h2>פניות שחזרו</h2><span>{summary.realRecovered.length}</span></header>
        {summary.realRecovered.length ? (
          <div className="result-list">
            {summary.realRecovered.map((outcome) => (
              <RealResultRow key={outcome.id} outcome={outcome} organizationId={organizationId} onCorrected={handleCorrected} />
            ))}
          </div>
        ) : (
          <EmptyState title="עוד אין תוצאות אמיתיות — וזה בסדר."><p>כאן יופיעו רק פניות אמיתיות שחזרו. נתוני תרגול לא נספרים.</p></EmptyState>
        )}
      </section>
      {summary.demoRecovered.length ? (
        <section className="result-list-section" aria-label="המחשת תוצאות מנתוני דוגמה">
          <header><h2>כך נראית תוצאה במסלול הדוגמה</h2><span>{summary.demoRecovered.length}</span></header>
          <Notice tone="sage"><strong>תרגול בלבד.</strong> הפניות והשלבים הבאים אינם חלק מתוצאות המרפאה, וכל סכום בהם אינו נספר כהכנסה.</Notice>
          <DemoResultRows outcomes={summary.demoRecovered} />
        </section>
      ) : null}
    </div>
  );
}

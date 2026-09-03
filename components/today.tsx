"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  advanceRecoveryLead,
  confirmRecoveredRevenue,
  createChangeAndMatch,
  deferRecoveryProgress,
  listLeads,
  listMessages,
  listOutcomes,
  listRecommendations,
  markRecoveryMessageSent,
  prepareRecoveryMessage,
  recordFollowUpRequest,
  recordRecoveryResponse,
  snoozeRecoveryMessage,
  updateLead,
  updateMessage,
  type NewChangeInput,
} from "@/lib/data";
import { reportClientError } from "@/lib/report-error";
import { dueRequestedContactCount } from "@/lib/priorities";
import { friendlyError, getSupabase } from "@/lib/supabase";
import {
  canShowRecoveryProgress,
  isRecommendationActive,
  nextRecommendationBatch,
  orderRecoveryProgressQueue,
  planTodayPendingWork,
} from "@/lib/today-flow";
import type { ChangeType, Lead, Outcome, OutreachMessage, Recommendation } from "@/lib/types";
import { useWorkspace } from "./workspace-gate";
import { EmptyState, ErrorState, Notice, Spinner } from "./ui";

interface TodayData {
  leads: Lead[];
  recommendations: Recommendation[];
  messages: OutreachMessage[];
  outcomes: Outcome[];
}

const pendingMessageStatuses = new Set<OutreachMessage["status"]>(["draft", "copied"]);

const changeOptions: { type: ChangeType; title: string; description: string; icon: string }[] = [
  { type: "slot", title: "התפנה תור", description: "תאריך ושעה מסוימים", icon: "◷" },
  { type: "availability", title: "נפתחה זמינות", description: "חלון חדש ביומן", icon: "＋" },
  { type: "service", title: "חזר שירות", description: "טיפול שחזר להיות זמין", icon: "↺" },
  { type: "requested_date", title: "הגיע מועד שביקשו לחזור", description: "בדיקת תאריכי חזרה", icon: "⌁" },
  { type: "payment", title: "אפשרות תשלום חדשה", description: "פריסה או תנאי חדשים", icon: "₪" },
  { type: "other", title: "משהו אחר", description: "נבדוק בלי לנחש או לשלוח", icon: "…" },
];

function formatDate(value: string | null) {
  if (!value) return "לא צוין";
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(value));
}

function dateTimeInputValue(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateInputValue(value: Date): string {
  return dateTimeInputValue(value).slice(0, 10);
}

function looksLikeDatedFollowUp(value: string): boolean {
  return /(?:\d{1,2}\s*[./-]\s*\d{1,2}|מחר|שבוע\s+הבא|חודש\s+הבא|לחזור\s+אל|תחזרו\s+אל)/i.test(value);
}

function tomorrowMorning(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function PageHeader({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return <header className="page-heading">{eyebrow && <p>{eyebrow}</p>}<h1>{title}</h1>{description && <span>{description}</span>}</header>;
}

function ChangeForm({ services, initialType, onDone }: { services: string[]; initialType?: ChangeType; onDone: (changeId: string, count: number, type: ChangeType) => void | Promise<void> }) {
  const { organizationId, clinic } = useWorkspace();
  const [type, setType] = useState<ChangeType | null>(initialType || null);
  const [service, setService] = useState(clinic?.main_service || services[0] || "");
  const [startsAt, setStartsAt] = useState(initialType === "requested_date" ? dateInputValue(new Date()) : "");
  const [endsAt, setEndsAt] = useState("");
  const [details, setDetails] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!type) return;
    setBusy(true);
    setError("");
    try {
      const label = changeOptions.find((option) => option.type === type)?.title || "שינוי חדש";
      const start = startsAt
        ? type === "requested_date"
          ? new Date(`${startsAt}T12:00:00Z`).toISOString()
          : new Date(startsAt).toISOString()
        : undefined;
      const startDate = start ? new Date(start) : null;
      if ((type === "slot" || type === "availability") && (!startDate || startDate.getTime() <= Date.now())) {
        setError("צריך לבחור מועד עתידי שעדיין אפשר לפעול לפיו.");
        setBusy(false);
        return;
      }
      const end = type === "availability" && endsAt
        ? new Date(endsAt).toISOString()
        : undefined;
      if (type === "availability" && (!end || new Date(end).getTime() <= startDate!.getTime())) {
        setError("סיום חלון הזמינות צריך להיות אחרי ההתחלה.");
        setBusy(false);
        return;
      }
      const fallbackDetails = type === "requested_date"
        ? `הגיע ${formatDate(start || new Date().toISOString())}, המועד שבו ביקשו שנחזור`
        : type === "slot" && start
          ? `התפנה תור ${new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(start))}`
          : label;
      const input: NewChangeInput = {
        type,
        service: type === "requested_date" ? "" : service,
        branch: branch || undefined,
        startsAt: start,
        endsAt: end,
        title: label,
        details: details.trim() || fallbackDetails,
      };
      const result = await createChangeAndMatch(getSupabase(), organizationId, input);
      await onDone(result.change.id, result.recommendations.length, type);
    } catch (saveError) {
      reportClientError("today.change", saveError, organizationId);
      setError(friendlyError(saveError));
      setBusy(false);
    }
  }

  if (!type) {
    return (
      <div className="flow-page">
        <PageHeader eyebrow="בדיקה חדשה" title="מה השתנה?" description="בחרו את הדבר שקרה. נבקש רק את הפרטים שצריך." />
        <div className="choice-grid">
          {changeOptions.map((option) => (
            <button type="button" key={option.type} onClick={() => setType(option.type)}>
              <span className="choice-icon">{option.icon}</span>
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
              <b aria-hidden="true">←</b>
            </button>
          ))}
        </div>
        <Notice>שום הודעה לא נוצרת לפני שנמצאת התאמה ברורה.</Notice>
      </div>
    );
  }

  const choice = changeOptions.find((option) => option.type === type)!;
  const needsService = type !== "requested_date" && type !== "other";
  const needsDate = type === "slot" || type === "availability" || type === "requested_date";
  const minimumFuture = dateTimeInputValue(new Date(Date.now() + 60_000));
  const latestRequestedDate = dateInputValue(new Date());

  return (
    <div className="flow-page flow-page--narrow">
      <button type="button" className="back-link" onClick={() => setType(null)}>→ חזרה לבחירה</button>
      <PageHeader eyebrow="מה השתנה?" title={choice.title} description="רק הפרטים שיעזרו לבדוק התאמה אמיתית." />
      <form className="detail-form" onSubmit={submit}>
        {needsService && <label><span>איזה שירות?</span><select value={service} onChange={(event) => setService(event.target.value)} required>{services.map((item) => <option key={item}>{item}</option>)}</select></label>}
        {needsDate && <label><span>{type === "requested_date" ? "נכון לאיזה יום?" : "מתי?"}</span><input type={type === "requested_date" ? "date" : "datetime-local"} value={startsAt} min={type === "requested_date" ? undefined : minimumFuture} max={type === "requested_date" ? latestRequestedDate : undefined} onChange={(event) => setStartsAt(event.target.value)} required /></label>}
        {type === "availability" && <label><span>עד מתי?</span><input type="datetime-local" value={endsAt} min={startsAt || minimumFuture} onChange={(event) => setEndsAt(event.target.value)} required /></label>}
        {(type === "payment" || type === "service" || type === "other") && <label><span>{type === "payment" ? "מה אפשר עכשיו?" : type === "service" ? "מה חזר להיות זמין?" : "מה בדיוק קרה?"}</span><textarea value={details} onChange={(event) => setDetails(event.target.value)} minLength={4} required placeholder={type === "payment" ? "למשל: אפשר לפרוס ל־4 תשלומים" : "כתבו במשפט קצר וברור"} /></label>}
        <label><span>סניף <small>(רשות)</small></span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="רק אם השינוי שייך לסניף מסוים" /></label>
        {type === "other" && <Notice tone="warning">שינוי חופשי יישמר לבדיקה, אבל לא ייצור הודעה אוטומטית. כדי למצוא התאמה בטוחה, עדיף לבחור תור, זמינות, שירות, מועד חזרה או תשלום.</Notice>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button--wide" disabled={busy}>{busy ? "בודקים למי זה רלוונטי…" : type === "other" ? "שמירה ובדיקה בטוחה" : "בדיקת הפניות"}</button>
      </form>
    </div>
  );
}

function EvidenceCard({ recommendation, onPrepare, busy }: { recommendation: Recommendation; onPrepare: () => void; busy: boolean }) {
  const lead = recommendation.lead;
  return (
    <article className="evidence-card">
      <header><div><h3>{lead?.name || "פנייה"}</h3><p>{lead?.service}</p></div>{lead?.value_minor ? <span>שווי אפשרי · ₪{Math.round(lead.value_minor / 100).toLocaleString("he-IL")}</span> : null}</header>
      <div className="evidence-line evidence-line--then"><span>אז</span><p>“{recommendation.then_text}”</p></div>
      <div className="evidence-line evidence-line--now"><span>עכשיו</span><p>{recommendation.now_text}</p></div>
      <div className="evidence-conclusion"><span>✓</span><div><strong>לכן</strong><p>יש סיבה אמיתית ליצור קשר מחדש.</p></div></div>
      <button className="button button--wide" onClick={onPrepare} disabled={busy}>{busy ? "מכינים…" : "להכין הודעה"}</button>
    </article>
  );
}

function MatchReview({ data, changeId, changeType, onPrepare }: { data: TodayData; changeId: string; changeType: ChangeType | null; onPrepare: (recommendation: Recommendation) => void }) {
  const { organizationId } = useWorkspace();
  const recommendations = data.recommendations.filter((item) => item.change_id === changeId
    && isRecommendationActive(item)
    && !data.messages.some((message) => message.recommendation_id === item.id));
  const total = data.leads.length;
  const [preparingId, setPreparingId] = useState("");
  const [error, setError] = useState("");

  async function prepare(recommendation: Recommendation) {
    setPreparingId(recommendation.id);
    setError("");
    try {
      await onPrepare(recommendation);
    } catch (prepareError) {
      reportClientError("today.prepare", prepareError, organizationId);
      setError(friendlyError(prepareError));
      setPreparingId("");
    }
  }

  return (
    <div className="flow-page">
      <PageHeader eyebrow="תוצאת הבדיקה" title={recommendations.length ? `ל־${recommendations.length} פניות יש סיבה טובה לפנות עכשיו` : "לא נמצאה סיבה טובה לפנות"} description={`בדקנו ${total} פניות. ${recommendations.length ? `${recommendations.length} קשורות לשינוי הזה.` : "שום הודעה לא נוצרה."}`} />
      {error && <div className="form-error" role="alert">{error}</div>}
      {recommendations.length ? <div className="evidence-list">{recommendations.map((item) => <EvidenceCard key={item.id} recommendation={item} onPrepare={() => void prepare(item)} busy={preparingId === item.id} />)}</div> : changeType === "other" ? <EmptyState title="השינוי נשמר בלי ליצור הודעה."><p>בשינוי חופשי אין מספיק מבנה כדי להוכיח התאמה בטוחה.</p><p>אם מדובר בתור, זמינות, שירות, מועד חזרה או תשלום — בחרו את האפשרות המדויקת ונבדוק שוב.</p></EmptyState> : <EmptyState title="עשינו בדיוק את הדבר הנכון."><p>השינוי הזה לא מספיק רלוונטי לאף פנייה כרגע.</p><p>לא נפנה לאנשים רק כדי “לנסות”.</p></EmptyState>}
    </div>
  );
}

function Approval({ lead, recommendation, message: initialMessage, outcome, onRefresh }: { lead: Lead; recommendation: Recommendation | null; message: OutreachMessage | null; outcome: Outcome | null; onRefresh: () => Promise<void> }) {
  const router = useRouter();
  const { organizationId } = useWorkspace();
  const [message, setMessage] = useState<OutreachMessage | null>(initialMessage);
  const [body, setBody] = useState(initialMessage?.body || recommendation?.suggested_message || "");
  const [stage, setStage] = useState<"approve" | "copied" | "sent">(initialMessage?.status === "sent" ? "sent" : initialMessage?.status === "copied" ? "copied" : "approve");
  const [response, setResponse] = useState(lead.response_text || outcome?.response_text || "");
  const [showFollowUpDate, setShowFollowUpDate] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [sendingChannel, setSendingChannel] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const markSentInFlight = useRef(false);

  async function copyMessage() {
    if (!message) return;
    setBusy(true); setError("");
    setCopyFailed(false);
    try {
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(body);
          copied = true;
        }
      } catch {
        // Safari may deny the modern clipboard API. Try the synchronous
        // selection-based fallback while this click still has user activation.
      }
      if (!copied && editorRef.current) {
        editorRef.current.focus();
        editorRef.current.select();
        try { copied = document.execCommand("copy"); } catch { copied = false; }
      }
      if (!copied) {
        editorRef.current?.focus();
        editorRef.current?.select();
        setCopyFailed(true);
        setError("לא הצלחנו להעתיק אוטומטית. הטקסט מסומן — העתיקו אותו ואז לחצו „העתקתי ידנית”.");
        return;
      }
      const saved = await updateMessage(getSupabase(), message.id, { body, status: "copied", copied_at: new Date().toISOString() });
      setMessage(saved);
      setStage("copied");
    } catch (saveError) { reportClientError("today.message.copy", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  async function confirmManualCopy() {
    if (!message) return;
    setBusy(true); setError("");
    try {
      const saved = await updateMessage(getSupabase(), message.id, { body, status: "copied", copied_at: new Date().toISOString() });
      setMessage(saved);
      setCopyFailed(false);
      setStage("copied");
    } catch (saveError) {
      reportClientError("today.message.manual-copy", saveError, organizationId);
      setError(friendlyError(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function markSent(channel: string) {
    if (!message || markSentInFlight.current) return;
    markSentInFlight.current = true;
    setSendingChannel(channel);
    setBusy(true); setError("");
    try {
      if (recommendation && !isRecommendationActive(recommendation)) {
        await snoozeRecoveryMessage(getSupabase(), organizationId, message.id);
        router.replace("/app/today/?done=expired");
        await onRefresh();
        return;
      }
      const result = await markRecoveryMessageSent(getSupabase(), organizationId, message.id, channel);
      if (!result.message) throw new Error("INVALID_TRANSITION_RESPONSE");
      setMessage(result.message);
      setStage("sent");
      await onRefresh();
    } catch (saveError) { reportClientError("today.message.sent", saveError, organizationId); setError(friendlyError(saveError)); }
    finally {
      markSentInFlight.current = false;
      setSendingChannel("");
      setBusy(false);
    }
  }

  async function snoozeMessage() {
    if (!message) { router.push("/app/today/"); return; }
    setBusy(true); setError("");
    try {
      await snoozeRecoveryMessage(getSupabase(), organizationId, message.id);
      router.replace("/app/today/?done=snoozed");
      await onRefresh();
    } catch (saveError) { reportClientError("today.message.snooze", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  async function record(type: "interested" | "not_now" | "no_reply" | "dnc") {
    if (!message) return;
    if (type === "dnc" && !window.confirm("לסמן שהתקבלה בקשה לא ליצור קשר? החסימה תמנע כל הודעה עתידית מ־Shuv Flow.")) return;
    if (type === "not_now" && looksLikeDatedFollowUp(response)) {
      setShowFollowUpDate(true);
      setError("נראה שהתבקש מועד חזרה. בחרו את התאריך כדי שלא נאבד אותו.");
      return;
    }
    setBusy(true); setError("");
    try {
      if (type === "interested" && !response.trim()) { setError("הדביקו או כתבו בקצרה מה הפנייה אמרה."); setBusy(false); return; }
      const result = await recordRecoveryResponse(getSupabase(), organizationId, message.id, type, response);
      if (result.lead?.medical_escalation) router.replace(`/app/today/?lead=${lead.id}`);
      else if (type === "interested") router.replace(`/app/today/?lead=${lead.id}`);
      else router.replace(`/app/today/?done=${type}`);
      await onRefresh();
    } catch (saveError) { reportClientError("today.response", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  async function saveFollowUpRequest() {
    if (!message) return;
    if (response.trim().length < 2) { setError("כתבו או הדביקו מה בדיוק נכתב בתשובה."); return; }
    if (!followUpDate) { setError("בחרו את התאריך שבו ביקשו שנחזור."); return; }
    setBusy(true); setError("");
    try {
      const result = await recordFollowUpRequest(
        getSupabase(),
        organizationId,
        message.id,
        response.trim(),
        followUpDate,
      );
      if (!result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
      if (result.lead.medical_escalation) router.replace(`/app/today/?lead=${lead.id}`);
      else router.replace("/app/today/?done=follow_up");
      await onRefresh();
    } catch (saveError) {
      reportClientError("today.response.follow-up", saveError, organizationId);
      setError(friendlyError(saveError));
    } finally { setBusy(false); }
  }

  return (
    <div className="flow-page flow-page--narrow">
      <PageHeader eyebrow={stage === "sent" ? "עדכון הפנייה" : "אישור הודעה"} title={lead.name} description={lead.service} />
      {stage !== "sent" && recommendation && <div className="reason-summary"><div><span>למה נעצרה</span><strong>{recommendation.then_text}</strong></div><div><span>למה עכשיו</span><strong>{recommendation.now_text}</strong></div></div>}

      {stage === "approve" && <>
        <label className="message-editor"><span>הודעה מוצעת</span><textarea ref={editorRef} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <p className="approval-promise"><span>●</span> שום הודעה לא נשלחת בלי אישור.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        {copyFailed && <button className="button button--wide" onClick={confirmManualCopy} disabled={busy}>{busy ? "שומרים…" : "העתקתי ידנית"}</button>}
        {!copyFailed && <button className="button button--wide" onClick={copyMessage} disabled={busy || !message || body.trim().length < 10}>{!message ? "מכינים את ההודעה…" : busy ? "מעתיקים…" : "אישור והעתקה"}</button>}
        <button className="text-button" onClick={snoozeMessage} disabled={busy}>לא עכשיו</button>
      </>}

      {stage === "copied" && <section className="copied-state">
        <span className="success-seal">✓</span><h2>ההודעה הועתקה.</h2><p>שלחו אותה בערוץ שבו אתם מדברים עם {lead.name.split(" ")[0]}, ואז חזרו לכאן.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="channel-actions"><button onClick={() => markSent("whatsapp")} disabled={busy}>{sendingChannel === "whatsapp" ? "שומרים…" : "שלחתי ב־WhatsApp"}</button><button onClick={() => markSent("sms")} disabled={busy}>{sendingChannel === "sms" ? "שומרים…" : "שלחתי בהודעה"}</button><button onClick={() => markSent("email")} disabled={busy}>{sendingChannel === "email" ? "שומרים…" : "שלחתי באימייל"}</button></div>
        <details><summary>ההעתקה לא עבדה?</summary><p className="manual-copy" onClick={() => window.getSelection()?.selectAllChildren(document.querySelector(".manual-copy")!)}>{body}</p></details>
        <button className="text-button" onClick={() => router.push("/app/today/")} disabled={busy}>אעשה את זה אחר כך</button>
      </section>}

      {stage === "sent" && <section className="response-panel">
        <h2>מה קרה?</h2><p>בחרו רק אחרי שיש עדכון אמיתי מהפנייה.</p>
        <label><span>מה נכתב? <small>(אם התקבלה תשובה)</small></span><textarea value={response} onChange={(event) => setResponse(event.target.value)} placeholder="אפשר להדביק כאן את התשובה" /></label>
        {showFollowUpDate && <div className="detail-form">
          <label><span>באיזה תאריך ביקשו שנחזור?</span><input type="date" value={followUpDate} min={dateInputValue(new Date())} max={dateInputValue(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))} onChange={(event) => setFollowUpDate(event.target.value)} /></label>
          <button className="button button--wide" onClick={saveFollowUpRequest} disabled={busy}>{busy ? "שומרים את המועד…" : "שמירת מועד החזרה"}</button>
          <button className="text-button" onClick={() => { setShowFollowUpDate(false); setError(""); }} disabled={busy}>ביטול</button>
        </div>}
        {error && <div className="form-error" role="alert">{error}</div>}
        {!showFollowUpDate && <div className="quick-actions"><button onClick={() => record("interested")} disabled={busy}>יש עניין מחדש</button><button onClick={() => record("not_now")} disabled={busy}>לא כרגע</button><button onClick={() => { setShowFollowUpDate(true); setError(""); }} disabled={busy}>ביקשו שנחזור בתאריך</button><button onClick={() => record("no_reply")} disabled={busy}>לא התקבלה תשובה</button><button className="danger" onClick={() => record("dnc")} disabled={busy}>לא ליצור קשר</button></div>}
      </section>}
    </div>
  );
}

function LeadProgress({ lead, outcome, onRefresh }: { lead: Lead; outcome: Outcome | null; onRefresh: () => Promise<void> }) {
  const router = useRouter();
  const { organizationId } = useWorkspace();
  const [currentLead, setCurrentLead] = useState(lead);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstName = currentLead.name.split(" ")[0];

  async function advance(status: "contacted" | "booked" | "closed" | "not_now") {
    setBusy(true); setError("");
    try {
      const result = await advanceRecoveryLead(getSupabase(), organizationId, currentLead.id, status);
      if (!result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
      setCurrentLead(result.lead);
      await onRefresh();
    } catch (saveError) { reportClientError("today.progress", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  async function confirmRevenue() {
    const shekels = Number(amount);
    if (!Number.isFinite(shekels) || shekels <= 0) { setError("הזינו את הסכום שהתקבל בפועל."); return; }
    const formatted = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(shekels);
    if (!window.confirm(`לאשר שהתקבלה בפועל הכנסה בסך ${formatted}? הסכום יופיע בתוצאות כהכנסה מאושרת.`)) return;
    setBusy(true); setError("");
    try {
      await confirmRecoveredRevenue(getSupabase(), organizationId, currentLead.id, Math.round(shekels * 100));
      router.replace("/app/results/?recovered=1");
      await onRefresh();
    } catch (saveError) { reportClientError("today.revenue", saveError, organizationId); setError(friendlyError(saveError)); setBusy(false); }
  }

  async function deferUntilTomorrow() {
    setBusy(true); setError("");
    try {
      const result = await deferRecoveryProgress(
        getSupabase(),
        organizationId,
        currentLead.id,
        tomorrowMorning(),
      );
      if (!result.lead) throw new Error("INVALID_TRANSITION_RESPONSE");
      setCurrentLead(result.lead);
      router.replace("/app/today/?done=deferred");
      await onRefresh();
    } catch (saveError) {
      reportClientError("today.progress.defer", saveError, organizationId);
      setError(friendlyError(saveError));
    } finally { setBusy(false); }
  }

  const status = currentLead.status;
  return (
    <div className="flow-page flow-page--narrow">
      <PageHeader eyebrow="פנייה חזרה" title="הפנייה חזרה להתעניין" description={`${firstName} · ${currentLead.service}`} />
      <div className="positive-reply"><span>“</span><p>{currentLead.response_text || outcome?.response_text || "הפנייה חזרה להתעניין."}</p></div>
      {status === "interested" && <section className="next-step"><span>הצעד הבא לצוות</span><h2>ליצור קשר ולקבוע תור.</h2><p>Shuv Flow לא יוצר קשר במקומכם — רק מוודא שהמשך הטיפול בפנייה לא מתפספס.</p><button className="button button--wide" onClick={() => advance("contacted")} disabled={busy}>סימון שיצרנו קשר</button></section>}
      {status === "contacted" && <section className="next-step"><span>מה הוחלט לגבי {firstName}?</span><h2>האם נקבע תור?</h2><div className="split-actions"><button className="button" onClick={() => advance("booked")} disabled={busy}>נקבע תור</button><button className="button button--secondary" onClick={() => advance("not_now")} disabled={busy}>לא נסגר</button></div></section>}
      {status === "booked" && <section className="next-step"><span>התור נקבע</span><h2>האם העסקה נסגרה?</h2><p>סמנו רק אחרי שיש אישור אמיתי מהצוות.</p><button className="button button--wide" onClick={() => advance("closed")} disabled={busy}>כן, נסגרה</button><button className="text-button" onClick={deferUntilTomorrow} disabled={busy}>{busy ? "שומרים…" : "עדיין לא — לבדוק שוב מחר"}</button></section>}
      {status === "closed" && <section className="revenue-confirm"><span>אישור ידני בלבד</span><h2>האם התקבלה הכנסה?</h2><p>רק סכום שמישהו מהצוות מאשר יופיע בתוצאות.</p><label><span>הסכום שהתקבל</span><div className="money-input"><b>₪</b><input type="number" min="1" step="1" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" /></div></label><button className="button button--wide" onClick={confirmRevenue} disabled={busy}>אישור הכנסה</button><button className="text-button" onClick={deferUntilTomorrow} disabled={busy}>{busy ? "שומרים…" : "עדיין לא התקבלה — לבדוק שוב מחר"}</button></section>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}

function UnavailableAction({ reason = "הסיבה לפנייה כבר אינה בתוקף." }: { reason?: string }) {
  const router = useRouter();
  return (
    <div className="flow-page flow-page--narrow">
      <PageHeader eyebrow="הפעולה נסגרה" title="אין כרגע הודעה שצריך לשלוח" description={reason} />
      <Notice>לא נשלח הודעה רק כי היא הוכנה בעבר. אם יקרה שינוי חדש, נבדוק שוב למי הוא באמת רלוונטי.</Notice>
      <button className="button button--wide" onClick={() => router.replace("/app/today/")}>חזרה להיום</button>
    </div>
  );
}

function MedicalEscalation({ lead }: { lead: Lead }) {
  const router = useRouter();
  return (
    <div className="flow-page flow-page--narrow">
      <PageHeader eyebrow="בדיקה אנושית נדרשת" title={`${lead.name} הועברה לצוות הרפואי`} description="נמצא מידע רפואי שדורש שיקול דעת מקצועי." />
      <Notice tone="warning">Shuv Flow עצרה את מסלול המכירה. אין לשלוח את ההודעה המוצעת ואין לקדם תור דרך המערכת.</Notice>
      <section className="next-step">
        <span>הצעד הבא לצוות</span>
        <h2>להעביר את הפנייה לבדיקה רפואית.</h2>
        <p>רק איש צוות מוסמך יחליט אם וכיצד נכון ליצור קשר מחדש.</p>
      </section>
      <button className="button button--wide" onClick={() => router.replace("/app/today/")}>חזרה להיום</button>
    </div>
  );
}

export function Today() {
  const router = useRouter();
  const search = useSearchParams();
  const { organizationId, clinic } = useWorkspace();
  const [data, setData] = useState<TodayData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const queryKey = search.toString();

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const client = getSupabase();
      let [leads, recommendations, messages, outcomes] = await Promise.all([
        listLeads(client, organizationId),
        listRecommendations(client, organizationId),
        listMessages(client, organizationId),
        listOutcomes(client, organizationId),
      ]);

      const pendingPlan = planTodayPendingWork(leads, recommendations, messages);
      const staleMessageIds = new Set(pendingPlan.stalePendingMessageIds);
      const staleMessages = messages.filter((message) => staleMessageIds.has(message.id));
      if (staleMessages.length) {
        await Promise.all(staleMessages.map((message) => updateMessage(client, message.id, { status: "snoozed" })));
        const resetLeadIds = new Set(pendingPlan.leadIdsToReset);
        const leadsToReset = leads.filter((lead) => resetLeadIds.has(lead.id));
        await Promise.all(leadsToReset.map((lead) => updateLead(client, lead.id, { status: "watching" })));
        messages = messages.map((message) => staleMessages.some((stale) => stale.id === message.id) ? { ...message, status: "snoozed" as const } : message);
        leads = leads.map((lead) => leadsToReset.some((reset) => reset.id === lead.id) ? { ...lead, status: "watching" as const } : lead);
      }
      setData({ leads, recommendations, messages, outcomes });
      setStatus("ready");
    } catch (loadError) { reportClientError("today.load", loadError, organizationId); setStatus("error"); }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load, queryKey]);
  const services = useMemo(() => Array.from(new Set([clinic?.main_service || "", ...(data?.leads.map((lead) => lead.service) || [])])).filter(Boolean), [clinic, data]);

  if (status === "loading") return <Spinner label="בודקים מה דורש תשומת לב…" />;
  if (status === "error" || !data) return <ErrorState onRetry={load} />;

  const changeParam = search.get("change");
  const initialChangeType = changeOptions.some((option) => option.type === changeParam) ? changeParam as ChangeType : undefined;
  if (search.has("change")) return <ChangeForm services={services} initialType={initialChangeType} onDone={async (id, _count, type) => {
    setStatus("loading");
    await load();
    router.replace(`/app/today/?matches=${id}&type=${type}`);
  }} />;
  const changeId = search.get("matches");
  if (changeId) return <MatchReview key={changeId} data={data} changeId={changeId} changeType={search.get("type") as ChangeType | null} onPrepare={async (recommendation) => {
    if (!isRecommendationActive(recommendation)) {
      router.replace("/app/today/?done=expired");
      return;
    }
    const prepared = await prepareRecoveryMessage(getSupabase(), organizationId, recommendation.id);
    const message = prepared.message;
    if (message.status === "sent") {
      router.push(`/app/today/?lead=${recommendation.lead_id}`);
      return;
    }
    if (message.status === "snoozed") {
      router.replace("/app/today/?done=snoozed");
      return;
    }
    setStatus("loading");
    await load();
    router.push(`/app/today/?approve=${recommendation.id}`);
  }} />;

  const approveId = search.get("approve");
  if (approveId) {
    const recommendation = data.recommendations.find((item) => item.id === approveId) || null;
    const message = data.messages.find((item) => item.recommendation_id === approveId) || null;
    const lead = data.leads.find((item) => item.id === (recommendation?.lead_id || message?.lead_id));
    const outcome = data.outcomes.find((item) => item.lead_id === lead?.id) || null;
    if (!lead) return <UnavailableAction />;
    if (lead.medical_escalation) return <MedicalEscalation lead={lead} />;
    if (lead.dnc) return <UnavailableAction reason="התקבלה בקשה לא ליצור קשר, ולכן הפנייה חסומה." />;
    if (lead.status === "closed" && outcome?.revenue_confirmed_at) return <UnavailableAction reason="ההכנסה מהפנייה הזו כבר אושרה ומופיעה בתוצאות." />;
    if (canShowRecoveryProgress(lead)) return <LeadProgress key={lead.id} lead={lead} outcome={outcome} onRefresh={load} />;
    if ((lead.status === "waiting" || lead.status === "approval") && message?.status === "sent") return <Approval key={`${lead.id}:${message.id}`} lead={lead} recommendation={recommendation} message={message} outcome={outcome} onRefresh={load} />;
    if (lead.status !== "approval" || !recommendation || !isRecommendationActive(recommendation) || message?.status === "snoozed" || message?.status === "sent") return <UnavailableAction />;
    return <Approval key={`${lead.id}:${recommendation.id}`} lead={lead} recommendation={recommendation} message={message} outcome={outcome} onRefresh={load} />;
  }

  const leadId = search.get("lead");
  if (leadId) {
    const lead = data.leads.find((item) => item.id === leadId);
    const outcome = data.outcomes.find((item) => item.lead_id === leadId) || null;
    if (!lead) return <ErrorState onRetry={() => router.replace("/app/today/")} />;
    if (lead.medical_escalation) return <MedicalEscalation lead={lead} />;
    if (lead.dnc) return <UnavailableAction reason="התקבלה בקשה לא ליצור קשר, ולכן הפנייה חסומה." />;
    if (lead.status === "closed" && outcome?.revenue_confirmed_at) return <UnavailableAction reason="ההכנסה מהפנייה הזו כבר אושרה ומופיעה בתוצאות." />;
    if (canShowRecoveryProgress(lead)) return <LeadProgress key={lead.id} lead={lead} outcome={outcome} onRefresh={load} />;
    if (lead.status === "approval") {
      const sentMessage = data.messages.find((item) => item.lead_id === lead.id && item.status === "sent");
      if (sentMessage) {
        const sentRecommendation = data.recommendations.find((item) => item.id === sentMessage.recommendation_id) || null;
        return <Approval key={`${lead.id}:${sentMessage.id}`} lead={lead} recommendation={sentRecommendation} message={sentMessage} outcome={outcome} onRefresh={load} />;
      }
      const message = data.messages.find((item) => item.lead_id === lead.id && pendingMessageStatuses.has(item.status));
      const recommendation = data.recommendations.find((item) => item.id === message?.recommendation_id && isRecommendationActive(item))
        || data.recommendations.find((item) => item.lead_id === lead.id && isRecommendationActive(item) && !data.messages.some((candidate) => candidate.recommendation_id === item.id))
        || null;
      if (!recommendation) return <UnavailableAction />;
      return <Approval key={`${lead.id}:${recommendation.id}`} lead={lead} recommendation={recommendation} message={message || null} outcome={outcome} onRefresh={load} />;
    }
    if (lead.status === "waiting") {
      const message = data.messages.find((item) => item.lead_id === lead.id && item.status === "sent") || null;
      const recommendation = data.recommendations.find((item) => item.id === message?.recommendation_id) || null;
      if (!message) return <UnavailableAction reason="הפנייה מסומנת כממתינה, אבל לא נמצא תיעוד של הודעה שנשלחה." />;
      return <Approval key={`${lead.id}:${message.id}`} lead={lead} recommendation={recommendation} message={message} outcome={outcome} onRefresh={load} />;
    }
    return <UnavailableAction reason={lead.dnc ? "הפנייה חסומה ולא תיכנס למסלול יצירת קשר." : "אין לפנייה הזו פעולה פתוחה כרגע."} />;
  }

  const activeRecommendationIds = new Set(data.recommendations.filter((item) => isRecommendationActive(item)).map((item) => item.id));
  const activePositiveQueue = orderRecoveryProgressQueue(data.leads.filter((lead) => (
    canShowRecoveryProgress(lead)
    && !data.outcomes.find((outcome) => outcome.lead_id === lead.id)?.revenue_confirmed_at
  )));
  const activePositive = activePositiveQueue[0];
  const unsentMessages = data.messages.filter((message) => pendingMessageStatuses.has(message.status) && activeRecommendationIds.has(message.recommendation_id));
  const sentMessages = data.messages.filter((message) => {
    const lead = data.leads.find((item) => item.id === message.lead_id);
    return message.status === "sent" && Boolean(lead) && !lead!.dnc && !lead!.medical_escalation && !lead!.needs_fix && lead!.stopped_reason_code !== "unknown" && ["waiting", "approval"].includes(lead!.status);
  });
  const recommendationBatch = nextRecommendationBatch(data.recommendations, data.messages);
  const dueRequestedContacts = dueRequestedContactCount(data.leads);

  let focus: { count?: number; title: string; description: string; action?: string; href?: string; tone: string };
  if (activePositive) focus = activePositiveQueue.length === 1
    ? { count: 1, title: "פנייה אחת מחכה להמשך.", description: "יש לצוות צעד ברור לביצוע.", action: "לראות מה צריך לעשות", href: `/app/today/?lead=${activePositive.id}`, tone: "positive" }
    : { count: activePositiveQueue.length, title: `${activePositiveQueue.length} פניות מחכות להמשך.`, description: "מתחילים בתשובה הטרייה ביותר, ואז עוברים לשאר.", action: "לפעולה הבאה", href: `/app/today/?lead=${activePositive.id}`, tone: "positive" };
  else if (unsentMessages.length) focus = unsentMessages.length === 1
    ? { count: 1, title: "הודעה אחת מחכה לאישור.", description: "ההודעה קשורה לסיבה ברורה. שום דבר לא נשלח לבד.", action: "לעבור על ההודעה", href: `/app/today/?approve=${unsentMessages[0].recommendation_id}`, tone: "approval" }
    : { count: unsentMessages.length, title: `${unsentMessages.length} הודעות מחכות לאישור.`, description: "כל הודעה קשורה לסיבה ברורה. שום דבר לא נשלח לבד.", action: "לעבור עליהן", href: `/app/today/?approve=${unsentMessages[0].recommendation_id}`, tone: "approval" };
  else if (recommendationBatch) focus = recommendationBatch.recommendationIds.length === 1
    ? { count: 1, title: "מצאנו פנייה אחת ששווה לבדוק היום.", description: "יש קשר ברור בין מה שעצר את הפנייה לבין מה שהשתנה.", action: "לבדיקת הפנייה", href: `/app/today/?matches=${recommendationBatch.changeId}`, tone: "match" }
    : { count: recommendationBatch.recommendationIds.length, title: `מצאנו ${recommendationBatch.recommendationIds.length} פניות ששווה לבדוק היום.`, description: "כל הפניות קשורות לאותו שינוי ובכל אחת יש סיבה ברורה.", action: `לראות את ה־${recommendationBatch.recommendationIds.length}`, href: `/app/today/?matches=${recommendationBatch.changeId}`, tone: "match" };
  else if (dueRequestedContacts) focus = dueRequestedContacts === 1
    ? { count: 1, title: "הגיע המועד שבו ביקשו שנחזור לפנייה אחת.", description: "המועד מבוסס על תאריך מפורש שנשמר. עדיין לא נוצרה הודעה.", action: "בדיקת הפנייה", href: "/app/today/?change=requested_date", tone: "match" }
    : { count: dueRequestedContacts, title: `הגיע המועד שבו ביקשו שנחזור ל־${dueRequestedContacts} פניות.`, description: "המועדים מבוססים על תאריכים מפורשים שנשמרו. עדיין לא נוצרה הודעה.", action: "בדיקת הפניות", href: "/app/today/?change=requested_date", tone: "match" };
  else if (sentMessages.length) focus = { count: sentMessages.length, title: "כרגע לא צריך לעשות דבר.", description: `${sentMessages.length} פניות ממתינות לתשובה. כשיש עדכון, אפשר לרשום אותו כאן.`, action: "עדכון פנייה", href: `/app/today/?lead=${sentMessages[0].lead_id}`, tone: "waiting" };
  else if (!data.leads.length) focus = { title: "כדי להתחיל, העלו פניות שלא נסגרו.", description: "מספיק שם וטלפון או אימייל.", action: "לעמוד הפניות", href: "/app/leads/", tone: "empty" };
  else focus = { title: "כרגע אין סיבה טובה לפנות לאף אחד.", description: `בדקנו ${data.leads.length} פניות. לא נשלח הודעה רק כי עבר זמן.`, tone: "quiet" };

  return (
    <div className="today-page">
      <header className="today-heading"><p>{new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</p><h1>מה כדאי לעשות עכשיו?</h1></header>
      {search.get("welcome") && <Notice tone="success">הפניות נקלטו. עכשיו Shuv Flow מחפש רק סיבות אמיתיות לפעולה.</Notice>}
      {search.get("done") === "expired"
        ? <Notice tone="warning">הסיבה הקודמת כבר אינה בתוקף, ולכן ההודעה נסגרה ולא תישלח.</Notice>
        : search.get("done") && <Notice>העדכון נשמר. לא תיווצר פנייה נוספת בלי סיבה חדשה.</Notice>}
      <section className={`today-focus today-focus--${focus.tone}`}>
        <div className="today-focus__top"><span className="pulse-mark" aria-hidden="true" />{focus.count && <b>{focus.count}</b>}</div>
        <h2>{focus.title}</h2>
        <p>{focus.description}</p>
        {focus.action && focus.href && <button className="button button--wide" onClick={() => router.push(focus.href!)}>{focus.action}</button>}
      </section>
      <button className="business-change-card" onClick={() => router.push("/app/today/?change=1")}>
        <span className="business-change-card__icon">＋</span>
        <span><strong>קרה משהו חדש בעסק?</strong><small>תור שהתפנה, זמינות שנפתחה או שירות שחזר</small></span>
        <b aria-hidden="true">←</b>
      </button>
      <div className="quiet-rule"><span>✓</span><p><strong>אין סיבה. אין הודעה.</strong><br />המערכת לא פונה לאנשים רק כי עבר זמן.</p></div>
    </div>
  );
}

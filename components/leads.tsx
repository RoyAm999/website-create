"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { importLeads, listLeads, listOutcomes, updateLead } from "@/lib/data";
import { inferStoppedReason, parseCsv } from "@/lib/csv";
import { hasMedicalEscalation, hasNoContactRequest, hasUnspecifiedAvailabilityConstraint, normalizeEmail, normalizePhone } from "@/lib/lead-safety";
import { hasConcreteTimingEvidence } from "@/lib/matching";
import { reportClientError } from "@/lib/report-error";
import { friendlyError, getSupabase } from "@/lib/supabase";
import type { Lead, LeadStatus, Outcome, StoppedReason } from "@/lib/types";
import { useWorkspace } from "./workspace-gate";
import { EmptyState, ErrorState, Notice, Spinner } from "./ui";

const visibleStatus: Record<LeadStatus, string> = {
  watching: "אין כרגע סיבה טובה לפנות",
  approval: "הודעה מחכה לאישור",
  waiting: "בהמתנה לתשובה",
  interested: "התקבלה התעניינות",
  contacted: "הצוות ביצע חזרה",
  booked: "נקבע תור",
  closed: "נסגר",
  not_now: "לא כרגע",
  no_reply: "לא התקבלה תשובה",
  medical_review: "נדרשת בדיקה רפואית — אין לפנות",
  dnc: "אין ליצור קשר",
};

const reasonLabels: Record<StoppedReason, string> = {
  timing: "השעה או היום לא התאימו",
  availability: "לא הייתה זמינות מתאימה",
  service: "השירות לא היה זמין",
  payment: "הייתה חסרה אפשרות תשלום",
  requested_date: "סוכם לחזור במועד מסוים",
  needs_time: "היה צורך בעוד זמן",
  price: "המחיר לא התאים",
  no_response: "לא התקבלה תשובה",
  competitor: "נבחר מקום אחר",
  not_interested: "לא היה עניין",
  unknown: "עדיין לא ברור",
};

const todayStatuses = new Set<LeadStatus>(["approval", "waiting", "interested", "contacted", "booked"]);
const attentionStatuses = new Set<LeadStatus>(["approval", "interested", "contacted", "booked"]);

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(value)) : "לא צוין";
}

function isMedicalLead(lead: Lead) {
  return lead.medical_escalation || lead.status === "medical_review";
}

function displayStatus(lead: Lead, completed = false) {
  if (lead.dnc) return visibleStatus.dnc;
  if (isMedicalLead(lead)) return visibleStatus.medical_review;
  if (lead.needs_fix) return "אין מספיק מידע כדי להחליט";
  if (completed) return "התהליך הושלם";
  return visibleStatus[lead.status];
}

function LeadCard({ lead, completed, onClick }: { lead: Lead; completed: boolean; onClick: () => void }) {
  const medical = isMedicalLead(lead);
  const attention = !completed && (lead.needs_fix || medical || attentionStatuses.has(lead.status) || lead.status === "closed");
  return (
    <article className="lead-card">
      <div className="lead-card__identity"><span className="avatar">{lead.name.slice(0, 1)}</span><div><h2>{lead.name}</h2><p>{lead.service}{lead.value_minor ? <> · <bdi dir="ltr">₪&nbsp;{Math.round(lead.value_minor / 100).toLocaleString("he-IL")}</bdi></> : null}</p></div></div>
      {lead.is_demo && <span className="demo-badge">פניית דוגמה</span>}
      <dl><div><dt>למה נעצרה</dt><dd>{lead.stopped_reason_text}</dd></div><div><dt>שיחה אחרונה</dt><dd>{formatDate(lead.last_contact_at)}</dd></div></dl>
      <div className={`lead-status ${attention ? "lead-status--attention" : ""} ${lead.dnc || medical ? "lead-status--dnc" : ""}`}><span />{displayStatus(lead, completed)}</div>
      <button className="lead-card__open" type="button" onClick={onClick} aria-label={`פתיחת הפנייה של ${lead.name}${lead.is_demo ? ", פניית דוגמה" : ""}`}>פתיחת הפנייה <span aria-hidden="true">←</span></button>
    </article>
  );
}

function LeadDetail({ lead, completed, onUpdated }: { lead: Lead; completed: boolean; onUpdated: (lead: Lead) => void }) {
  const router = useRouter();
  const { organizationId } = useWorkspace();
  const medical = isMedicalLead(lead);
  const [editing, setEditing] = useState(() => !lead.dnc && !medical && (lead.needs_fix || lead.stopped_reason_code === "unknown"));
  const [name, setName] = useState(lead.name);
  const [phone, setPhone] = useState(lead.phone || "");
  const [email, setEmail] = useState(lead.email || "");
  const [service, setService] = useState(lead.service);
  const [reasonText, setReasonText] = useState(lead.stopped_reason_text);
  const [preferredTime, setPreferredTime] = useState(lead.preferred_time || "");
  const [requestedAfter, setRequestedAfter] = useState(lead.requested_contact_after?.slice(0, 10) || "");
  const [branch, setBranch] = useState(lead.branch || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contactOpen, setContactOpen] = useState(() => (!normalizePhone(lead.phone) && !normalizeEmail(lead.email)) || !lead.name.trim() || !lead.service.trim());
  const inferredReason = useMemo(() => inferStoppedReason(reasonText), [reasonText]);
  const reasonContext = `${reasonText} ${lead.notes}`;
  const dateSpecificAvailability = inferredReason.code === "availability" && hasUnspecifiedAvailabilityConstraint(reasonContext);
  const resolvedReason = dateSpecificAvailability ? "requested_date" : inferredReason.code;
  const needsTimingDetail = resolvedReason === "timing" && !hasConcreteTimingEvidence(preferredTime || reasonText);
  const needsRequestedDate = resolvedReason === "requested_date";
  const needsBranch = /סניף|branch/i.test(reasonContext);
  const medicalInText = hasMedicalEscalation(reasonContext);
  const noContactInText = hasNoContactRequest(reasonContext);

  async function saveReason() {
    if (lead.dnc || medical) {
      setEditing(false);
      setError(medical ? "הפנייה נעצרה לבדיקה רפואית ואי אפשר לקדם אותה במסלול המכירה." : "הפנייה חסומה ליצירת קשר.");
      return;
    }
    const safePhone = normalizePhone(phone);
    const safeEmail = normalizeEmail(email);
    if (!name.trim()) { setError("צריך לציין את שם הפנייה."); return; }
    if (!safePhone && !safeEmail) { setError("צריך לציין לפחות טלפון תקין או אימייל תקין."); return; }
    if (phone.trim() && !safePhone) { setError("מספר הטלפון אינו תקין."); return; }
    if (email.trim() && !safeEmail) { setError("כתובת האימייל אינה תקינה."); return; }
    if (!service.trim()) { setError("צריך לציין את השירות שהתעניין בו."); return; }
    if (resolvedReason === "unknown" || reasonText.trim().length < 4) { setError("כתבו במשפט קצר מה נאמר או נכתב בשיחה האחרונה."); return; }
    if (needsRequestedDate && !requestedAfter) { setError("הוסיפו את המועד שסוכם כדי שלא נחזור מוקדם מדי."); return; }
    if (needsTimingDetail) { setError("הוסיפו את השעה או היום שהתאימו לפנייה."); return; }
    if (needsBranch && !branch.trim()) { setError("הוסיפו את הסניף שהתבקש כדי שלא נציע מקום לא מתאים."); return; }
    setBusy(true); setError("");
    try {
      const medicalEscalation = lead.medical_escalation || medicalInText;
      const updated = await updateLead(getSupabase(), lead.id, {
        name: name.trim(),
        phone: safePhone || null,
        email: safeEmail || null,
        service: service.trim(),
        stopped_reason_code: resolvedReason,
        stopped_reason_text: reasonText.trim(),
        preferred_time: resolvedReason === "timing" ? (preferredTime.trim() || reasonText.trim()) : null,
        requested_contact_after: resolvedReason === "requested_date" ? requestedAfter : null,
        branch: branch.trim() || null,
        dnc: noContactInText,
        medical_escalation: medicalEscalation,
        needs_fix: noContactInText ? false : medicalEscalation,
      });
      onUpdated(updated); setEditing(false);
    } catch (saveError) { reportClientError("leads.update", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  async function blockContact() {
    if (!window.confirm("הפנייה תיחסם ולא תופיע שוב בהמלצות. לחסום?")) return;
    setBusy(true);
    try {
      const updated = await updateLead(getSupabase(), lead.id, { dnc: true });
      onUpdated(updated);
    } catch (saveError) { reportClientError("leads.block", saveError, organizationId); setError(friendlyError(saveError)); }
    finally { setBusy(false); }
  }

  return (
    <div className="lead-detail">
      <button className="back-link" onClick={() => router.replace("/app/leads/")}>→ כל הפניות</button>
      <header><span className="avatar avatar--large">{lead.name.slice(0, 1)}</span><div><h1>{lead.name}</h1><p>{lead.service}</p></div>{lead.is_demo && <span className="demo-badge">פניית דוגמה</span>}</header>
      {lead.is_demo && <Notice tone="sage"><strong>זו פניית דוגמה בלבד.</strong><br />כל פעולה כאן היא תרגול ואינה יוצרת קשר עם אדם אמיתי.</Notice>}
      {lead.dnc && <Notice tone="warning"><strong>סומן שאין ליצור קשר.</strong><br />הפנייה חסומה ולא תופיע בהמלצות.</Notice>}
      {medical && <Notice tone="warning"><strong>המסלול האוטומטי נעצר לבדיקה רפואית.</strong><br />יש להעביר את תוכן הפנייה לאיש או אשת צוות רפואי מוסמך ולפעול לפי נוהלי המרפאה. אין לשלוח הודעת מכירה לפני החלטת הצוות.</Notice>}
      <section className="detail-section"><span>מה ידוע</span><dl><div><dt>טלפון</dt><dd dir="ltr">{lead.phone || "—"}</dd></div><div><dt>אימייל</dt><dd dir="ltr">{lead.email || "—"}</dd></div><div><dt>שיחה אחרונה</dt><dd>{formatDate(lead.last_contact_at)}</dd></div>{lead.value_minor > 0 && <div><dt>שווי אפשרי</dt><dd><bdi dir="ltr">₪&nbsp;{Math.round(lead.value_minor / 100).toLocaleString("he-IL")}</bdi></dd></div>}</dl></section>
      <section className="detail-section reason-detail">
        <span>למה נעצרה</span>
        {editing ? <div className="reason-editor">
          <label><span>מה נאמר או נכתב בשיחה האחרונה?</span><textarea value={reasonText} onChange={(event) => { setReasonText(event.target.value); setError(""); }} placeholder="למשל: יכולה להגיע רק אחרי 17:00" autoFocus /></label>
          <div className={`reason-inference ${resolvedReason === "unknown" ? "reason-inference--unknown" : ""}`} aria-live="polite">
            <span>מה הבנו</span>
            <strong>{reasonLabels[resolvedReason]}</strong>
            <p>{resolvedReason === "unknown" ? "כדי שנוכל לדעת מתי באמת נכון לחזור, צריך את המשפט שנאמר בשיחה." : "אין צורך לבחור קטגוריה — Shuv Flow מסדר את הסיבה לפי מה שנכתב."}</p>
          </div>
          {needsTimingDetail && <label><span>איזו שעה או איזה יום התאימו?</span><input value={preferredTime} onChange={(event) => setPreferredTime(event.target.value)} placeholder="למשל: אחרי 17:00 או ביום שישי" /></label>}
          {needsRequestedDate && <label><span>מתי סוכם לחזור?</span><input type="date" value={requestedAfter} onChange={(event) => setRequestedAfter(event.target.value)} required /></label>}
          {needsBranch && <label><span>איזה סניף התבקש?</span><input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="למשל: סניף צפון" /></label>}
          {noContactInText && <Notice tone="warning"><strong>הפנייה ביקשה שלא ייצרו איתה קשר.</strong><br />בשמירה היא תיחסם ולא תופיע בהמלצות.</Notice>}
          {medicalInText && <Notice tone="warning"><strong>מצאנו תוכן שדורש בדיקה רפואית.</strong><br />הפנייה תישמר לבדיקה ולא תיכנס למסלול הודעות.</Notice>}
          <details className="repair-contact-details" open={contactOpen} onToggle={(event) => setContactOpen(event.currentTarget.open)}>
            <summary>שם ופרטי קשר</summary>
            <p>פתחו רק אם צריך לתקן פרט שנקלט.</p>
            <div className="repair-contact-grid">
              <label><span>שם</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label><span>שירות</span><input value={service} onChange={(event) => setService(event.target.value)} /></label>
              <label><span>טלפון</span><input dir="ltr" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="050-0000000" /></label>
              <label><span>אימייל</span><input dir="ltr" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
            </div>
          </details>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button" onClick={saveReason} disabled={busy}>{busy ? "שומרים…" : noContactInText ? "שמירה וחסימת קשר" : medicalInText ? "שמירה והעברה לבדיקה" : "שמירת הפרטים"}</button>
        </div> : <>
          <blockquote>{lead.stopped_reason_text}</blockquote>
          {lead.requested_contact_after && <p>מועד חזרה: {formatDate(lead.requested_contact_after)}</p>}
          {lead.branch && <p>סניף: {lead.branch}</p>}
          {!lead.dnc && !medical && <button className="text-button text-button--inline" onClick={() => setEditing(true)}>תיקון הפרטים</button>}
        </>}
      </section>
      <section className="detail-section"><span>מה כדאי לעשות עכשיו</span><h2>{completed ? "התהליך הושלם." : medical ? "להעביר לבדיקה רפואית פנימית." : lead.dnc ? "אין ליצור קשר." : lead.needs_fix ? "להשלים את סיבת העצירה." : lead.status === "closed" ? "נשאר לאשר אם התקבלה הכנסה." : visibleStatus[lead.status]}</h2><p>{completed ? "ההכנסה שאושרה מופיעה במסך התוצאות, ואין עוד משימה פתוחה לפנייה הזאת." : medical ? "המערכת לא תציע הודעה ולא תאפשר התקדמות מכירתית. צוות רפואי מוסמך צריך לבדוק את הפנייה מחוץ למסלול המכירה." : lead.dnc ? "אין פעולה זמינה." : todayStatuses.has(lead.status) || lead.status === "closed" ? "הפעולה הבאה מופיעה במסך היום." : lead.status === "watching" ? "להמתין לשינוי אמיתי שרלוונטי לפנייה הזאת." : "אין כרגע פעולה נוספת לפנייה הזאת."}</p>{completed ? <button className="button button--secondary" onClick={() => router.push("/app/results/")}>לראות בתוצאות</button> : !lead.dnc && !medical && (todayStatuses.has(lead.status) || lead.status === "closed") ? <button className="button" onClick={() => router.push(`/app/today/?lead=${lead.id}`)}>פתיחה במסך היום</button> : null}</section>
      {!lead.dnc && <button className="danger-link" onClick={blockContact} disabled={busy}>סימון “לא ליצור קשר”</button>}
    </div>
  );
}

export function Leads() {
  const router = useRouter();
  const search = useSearchParams();
  const { organizationId, clinic } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(search.get("filter") || "all");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const [nextLeads, nextOutcomes] = await Promise.all([
        listLeads(getSupabase(), organizationId),
        listOutcomes(getSupabase(), organizationId),
      ]);
      setLeads(nextLeads);
      setOutcomes(nextOutcomes);
      setStatus("ready");
    }
    catch (loadError) { reportClientError("leads.load", loadError, organizationId); setStatus("error"); }
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const completedLeadIds = useMemo(() => new Set(
    outcomes.filter((outcome) => Boolean(outcome.revenue_confirmed_at)).map((outcome) => outcome.lead_id),
  ), [outcomes]);

  const filtered = useMemo(() => leads.filter((lead) => {
    const matchesText = !query || `${lead.name} ${lead.service} ${lead.phone || ""} ${lead.email || ""}`.toLowerCase().includes(query.toLowerCase());
    const needsAttention = !completedLeadIds.has(lead.id) && (lead.needs_fix || isMedicalLead(lead) || attentionStatuses.has(lead.status) || lead.status === "closed");
    const matchesFilter = filter === "all" || (filter === "attention" && needsAttention) || (filter === "waiting" && lead.status === "waiting");
    return matchesText && matchesFilter;
  }), [completedLeadIds, leads, query, filter]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setNotice("");
    try {
      const parsed = parseCsv(await file.text(), clinic?.main_service || "");
      const saved = await importLeads(getSupabase(), organizationId, [...parsed.valid, ...parsed.needsFix]);
      setNotice(`${saved.length} פניות נקלטו או עודכנו. שום הודעה לא נשלחה.`);
      await load();
    } catch (uploadError) { reportClientError("leads.import", uploadError, organizationId); setNotice(uploadError instanceof Error && uploadError.message.startsWith("MISSING_") ? "לא הצלחנו לקרוא את הקובץ. צריך לפחות שם וטלפון או אימייל." : friendlyError(uploadError)); }
    event.target.value = "";
  }

  async function removeDemo() {
    if (!window.confirm("למחוק רק את 20 פניות הדוגמה? הפניות שהעליתם לא יימחקו.")) return;
    const { error } = await getSupabase().from("sf_leads").delete().eq("organization_id", organizationId).eq("is_demo", true);
    if (error) reportClientError("leads.demo.delete", error, organizationId);
    setNotice(error ? friendlyError(error) : "פניות הדוגמה נמחקו.");
    if (!error) await load();
  }

  if (status === "loading") return <Spinner label="טוענים את הפניות…" />;
  if (status === "error") return <ErrorState onRetry={load} />;
  const selected = leads.find((lead) => lead.id === search.get("id"));
  if (selected) return <LeadDetail key={selected.id} lead={selected} completed={completedLeadIds.has(selected.id)} onUpdated={(updated) => setLeads((items) => items.map((item) => item.id === updated.id ? updated : item))} />;

  const hasDemo = leads.some((lead) => lead.is_demo);
  const realCount = leads.filter((lead) => !lead.is_demo).length;
  const demoCount = leads.length - realCount;
  const filteredReal = filtered.filter((lead) => !lead.is_demo);
  const filteredDemo = filtered.filter((lead) => lead.is_demo);
  return (
    <div className="leads-page">
      <header className="list-heading"><div><p>{realCount ? "הפניות במרפאה" : "סביבת תרגול"}</p><h1>{realCount ? `${realCount} פניות במעקב` : `${demoCount} פניות לדוגמה`}</h1></div><div><input ref={fileRef} className="sr-only" type="file" accept=".csv,text/csv" onChange={upload} /><button className="button button--secondary" onClick={() => fileRef.current?.click()}>הוספת פניות</button></div></header>
      {hasDemo && <div className="demo-strip"><span><b>{demoCount} פניות לדוגמה — תרגול בלבד.</b> הן מסומנות ומופרדות מהפניות ומהתוצאות של המרפאה.</span><button onClick={removeDemo}>מחיקת הדוגמה והעלאת הפניות שלי</button></div>}
      {notice && <Notice tone={notice.includes("לא הצלחנו") ? "warning" : "sage"}>{notice}</Notice>}
      {leads.length > 10 && <div className="lead-tools"><label className="search-field"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="חיפוש לפי שם או שירות" /></label><div className="filter-pills"><button className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>דורשות תשומת לב</button><button className={filter === "waiting" ? "active" : ""} onClick={() => setFilter("waiting")}>בהמתנה</button><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>הכול</button></div></div>}
      {filteredReal.length ? <div className="lead-grid">{filteredReal.map((lead) => <LeadCard key={lead.id} lead={lead} completed={completedLeadIds.has(lead.id)} onClick={() => router.push(`/app/leads/?id=${lead.id}`)} />)}</div> : null}
      {filteredDemo.length ? <section className="result-list-section" aria-label="פניות דוגמה"><header><h2>פניות לדוגמה · תרגול בלבד</h2><span>{filteredDemo.length}</span></header><div className="lead-grid">{filteredDemo.map((lead) => <LeadCard key={lead.id} lead={lead} completed={completedLeadIds.has(lead.id)} onClick={() => router.push(`/app/leads/?id=${lead.id}`)} />)}</div></section> : null}
      {!filtered.length ? <EmptyState title="אין כאן פניות כרגע."><p>אפשר לשנות את הסינון או להעלות פניות חדשות.</p></EmptyState> : null}
    </div>
  );
}

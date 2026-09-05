import { DEMO_LEADS } from './demo';
import { canMatchLead, concreteChangeDetails } from './matching';
import { clinicDateInputValue, clinicLocalDateTimeToIso } from './clinic-time';
import { consolidateImportLeads, existingLeadIdsForContact, hasMedicalEscalation, hasNoContactRequest, normalizeEmail, normalizePhone, safeReimportPatch } from './lead-safety';
import type { BusinessChange, ImportLead, Lead, LeadStatus, ChangeType } from './types';

export const GUEST_KEY = 'shuvflow-guest-v1';
export const MAX_LEADS = 1000;
export type Trail = { id: string; at: string; text: string };
export interface GuestLead extends Lead {
  trail: Trail[];
  draft?: string;
  draftChangeId?: string;
  sentAt?: string;
  repliedAt?: string;
  bookedAt?: string;
  closedAt?: string;
  revenueMinor?: number;
  revenueConfirmedAt?: string;
  snoozedUntil?: string;
  dismissedChanges?: string[];
}
export interface GuestState {
  version: 1;
  clinicName: string;
  mainService: string;
  leads: GuestLead[];
  changes: BusinessChange[];
  createdAt: string;
  updatedAt: string;
}
export type GuestMatch = { lead: GuestLead; change: BusinessChange; message: string; reason: string };
export const STATUS: Record<LeadStatus,string> = {
  watching:'במעקב', approval:'מוכנה לפנייה', waiting:'ממתינים לתשובה', interested:'חזרה לשיחה',
  contacted:'בתיאום', booked:'נקבע תור', closed:'נסגרה', not_now:'לא עכשיו', no_reply:'לא התקבלה תשובה', medical_review:'בדיקת צוות רפואי', dnc:'לא ליצור קשר',
};
export const CHANGE_LABEL: Record<ChangeType,string> = {slot:'התפנה תור',availability:'נוספה זמינות',payment:'אפשרות תשלום חדשה',service:'שירות חזר לפעילות',requested_date:'הגיע מועד לחזור',other:'עדכון אחר'};
export function uid(): string { return globalThis.crypto?.randomUUID?.() || `sf-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function dated(days: number, now = new Date()): string { return clinicDateInputValue(new Date(now.getTime()+days*86400000)); }
function trail(text: string, now=new Date()): Trail { return {id:uid(), at:now.toISOString(), text}; }
export function toGuestLead(row: ImportLead, demo=false, now=new Date()): GuestLead {
  const safetyText = `${row.notes||''} ${row.stopped_reason_text||''}`;
  const dnc = !!row.dnc || hasNoContactRequest(safetyText);
  const medical = !!row.medical_escalation || hasMedicalEscalation(safetyText);
  const phone = normalizePhone(row.phone)||null, email=normalizeEmail(row.email)||null;
  return {id:uid(), organization_id:'guest-local', external_ref:row.external_ref||null, name:row.name.trim(), phone,email,
    service:row.service.trim(), value_minor:row.value_minor||0, currency:'ILS',last_contact_at:row.last_contact_at||null,
    notes:row.notes||'',branch:row.branch||null,dnc,medical_escalation:medical,is_demo:demo,
    needs_fix:!!row.needs_fix || (!phone&&!email) || !row.name.trim() || !row.service.trim() || !row.stopped_reason_code || row.stopped_reason_code==='unknown',
    stopped_reason_code:row.stopped_reason_code||'unknown',stopped_reason_text:row.stopped_reason_text||'חסר תיעוד של הסיבה',
    preferred_time:row.preferred_time||null,requested_contact_after:row.requested_contact_after||null,
    status:dnc?'dnc':medical?'medical_review':'watching',response_text:null,created_at:now.toISOString(),updated_at:now.toISOString(),
    trail:[trail(demo?'פנייה לדוגמה נוספה לסביבת ההתנסות':'פנייה נוספה מקומית בדפדפן',now)]};
}
export function exampleChanges(now=new Date()): BusinessChange[] {
  const common={organization_id:'guest-local',branch:null,is_demo:true,created_at:now.toISOString()};
  const slot:BusinessChange={...common,id:'sample-slot',type:'slot',service:'טיפול פנים',title:'התפנה תור ערב',details:'',starts_at:clinicLocalDateTimeToIso(`${dated(1,now)}T18:30`),ends_at:null};
  slot.details=concreteChangeDetails(slot);
  return [slot,{...common,id:'sample-payment',type:'payment',service:'הסרת שיער',title:'אפשרות תשלום חדשה',details:'אפשר לחלק את התשלום ל־3 תשלומים ללא תוספת',starts_at:null,ends_at:clinicLocalDateTimeToIso(`${dated(14,now)}T23:59`)}];
}
export function createGuest(now=new Date()): GuestState {
  const leads=DEMO_LEADS.map((l,i)=>toGuestLead({...l,phone:undefined,email:`sample${i+1}@example.invalid`,last_contact_at:dated(-7-i,now),
    ...(i===3?{requested_contact_after:dated(0,now),stopped_reason_text:'ביקשה שנחזור אליה היום',notes:'ביקשה להמשיך את השיחה במועד שסיכמנו'}:{}),
    ...(i===16?{requested_contact_after:dated(10,now),stopped_reason_text:'ביקשה שנחזור אחרי החופשה',notes:'ביקשה ליצור קשר בתאריך שסוכם'}:{})},true,now));
  return {version:1,clinicName:'הקליניקה שלי',mainService:'טיפול פנים',leads,changes:exampleChanges(now),createdAt:now.toISOString(),updatedAt:now.toISOString()};
}
export function emptyGuest(name='הקליניקה שלי', now=new Date()):GuestState { return {...createGuest(now),clinicName:name,leads:[],changes:[]}; }
export function matchForLead(state: GuestState, lead:GuestLead, now=new Date()):GuestMatch|null {
  if (lead.snoozedUntil && new Date(lead.snoozedUntil)>now) return null;
  if (!normalizePhone(lead.phone)&&!normalizeEmail(lead.email)) return null;
  const due:BusinessChange={id:`date-${lead.id}-${lead.requested_contact_after}`,organization_id:'guest-local',type:'requested_date',service:lead.service,branch:lead.branch,
    title:'הגיע המועד שביקשה',details:`הגיע המועד שסוכם לחזרה: ${lead.requested_contact_after||''}`,starts_at:`${dated(0,now)}T12:00:00Z`,ends_at:null,is_demo:lead.is_demo,created_at:now.toISOString()};
  const changes=[...state.changes,...(lead.requested_contact_after?[due]:[])];
  const change=changes.find(c=>!lead.dismissedChanges?.includes(c.id)&&(!c.ends_at||new Date(c.ends_at)>now)&&canMatchLead(lead,c,now));
  if (!change) return null;
  const first=lead.name.split(' ')[0];
  const text=change.type==='requested_date'?`היי ${first}, כאן צוות ${state.clinicName}. חוזרים אלייך לגבי ${lead.service}, במועד שביקשת. מתאים לך להמשיך מאיפה שעצרנו?`:
    `היי ${first}, כאן צוות ${state.clinicName}. דיברנו על ${lead.service}, וציינת ש${lead.stopped_reason_text}. יש עדכון שיכול להתאים: ${change.details}. מתאים לך שנבדוק יחד?`;
  return {lead,change,message:lead.draftChangeId===change.id&&lead.draft?lead.draft:text,reason:change.type==='requested_date'?'המועד שביקשה הגיע. זו חזרה שסוכמה, לא הודעה אקראית.':`העדכון פותר את מה שעצר את השיחה על ${lead.service}.`};
}
export function matches(state:GuestState,now=new Date()):GuestMatch[] {
  return state.leads.map(l=>matchForLead(state,l,now)).filter((m):m is GuestMatch=>!!m).sort((a,b)=>{
    const aTime=a.change.type==='slot'?new Date(a.change.starts_at!).getTime():Infinity;
    const bTime=b.change.type==='slot'?new Date(b.change.starts_at!).getTime():Infinity;
    return (aTime-bTime)||((a.lead.last_contact_at||'').localeCompare(b.lead.last_contact_at||''));
  });
}
export function displayStatus(state:GuestState,lead:GuestLead,now=new Date()):string {
  if(lead.dnc)return STATUS.dnc;
  if(lead.medical_escalation)return STATUS.medical_review;
  if(lead.needs_fix)return 'חסר מידע';
  if(lead.snoozedUntil&&new Date(lead.snoozedUntil)>now)return 'תזכורת בהמשך';
  if(matchForLead(state,lead,now))return 'יש סיבה לחזור';
  return STATUS[lead.status];
}
export function updateLead(state:GuestState,id:string,patch:Partial<GuestLead>,text:string,now=new Date()):GuestState {
  return {...state,updatedAt:now.toISOString(),leads:state.leads.map(l=>l.id===id?{...l,...patch,updated_at:now.toISOString(),trail:[...l.trail,trail(text,now)]}:l)};
}
export function actOnLead(state:GuestState,id:string,action:string,value='',now=new Date()):GuestState {
  const l=state.leads.find(l=>l.id===id);if(!l)throw new Error('הפנייה לא נמצאה.');
  if(action==='note'){if(!value.trim())throw new Error('צריך להזין הערה.');return updateLead(state,id,{},value.trim().slice(0,2000),now);}
  if(action==='dnc')return updateLead(state,id,{dnc:true,status:'dnc',draft:undefined},'סומנה בקשה לא ליצור קשר. פנייה חוזרת נחסמה.',now);
  if(l.dnc||l.medical_escalation||l.needs_fix)throw new Error('אין לפנות לפני השלמת הבדיקה. חסימת קשר או בדיקה רפואית נשארות בתוקף.');
  if(action==='dismiss'){
    const m=matchForLead(state,l,now);if(!m)throw new Error('אין כרגע התאמה בתוקף.');
    return updateLead(state,id,{dismissedChanges:[...(l.dismissedChanges||[]),m.change.id],draft:undefined},'ההמלצה הזו אינה מתאימה. ממתינים לסיבה אחרת.',now);
  }
  if(action==='snooze')return updateLead(state,id,{snoozedUntil:new Date(now.getTime()+86400000).toISOString()},'הבדיקה הבאה נקבעה לעוד 24 שעות.',now);
  if(action==='sent'){
    const m=matchForLead(state,l,now);if(!m)throw new Error('הסיבה לחזור כבר אינה בתוקף. רעננו את ההמלצה.');
    if(!value.trim()||value.length>3000)throw new Error('נדרש נוסח הודעה באורך עד 3,000 תווים.');
    return updateLead(state,id,{status:'waiting',sentAt:now.toISOString(),draft:value.trim(),draftChangeId:m.change.id},'תועדה שליחה ידנית. המערכת לא שלחה הודעה.',now);
  }
  if(action==='reply'){
    if(l.status!=='waiting')throw new Error('קודם מתעדים הודעה שנשלחה.');
    if(!value.trim())throw new Error('צריך לתעד מה הפנייה ענתה.');
    if(hasNoContactRequest(value))return updateLead(state,id,{response_text:value,dnc:true,status:'dnc'},'התקבלה בקשת הסרה. הקשר נחסם.',now);
    if(hasMedicalEscalation(value))return updateLead(state,id,{response_text:value,medical_escalation:true,status:'medical_review'},'התשובה הועברה לבדיקת צוות רפואי. אין להמשיך בפנייה שיווקית.',now);
    return updateLead(state,id,{status:'interested',response_text:value,repliedAt:now.toISOString()},`התקבלה תשובה: ${value}`,now);
  }
  if(action==='not_now'){
    if(!['waiting','interested'].includes(l.status))throw new Error('הפעולה אינה זמינה בשלב הזה.');
    return updateLead(state,id,{status:'not_now'},'לא מתאים כרגע. אין שליחה נוספת ללא בקשה או סיבה חדשה.',now);
  }
  if(action==='no_reply'){
    if(l.status!=='waiting')throw new Error('אפשר לתעד זאת רק אחרי שליחה.');
    return updateLead(state,id,{status:'no_reply'},'לא התקבלה תשובה. לא נוצרת הודעה נוספת אוטומטית.',now);
  }
  if(action==='book'){
    if(!['interested','contacted'].includes(l.status))throw new Error('קודם מתעדים תשובה חיובית.');
    const time=new Date(value);if(!Number.isFinite(time.getTime())||time<=now)throw new Error('בחרו מועד עתידי לתור.');
    return updateLead(state,id,{status:'booked',bookedAt:value},`תועד תור ל־${new Intl.DateTimeFormat('he-IL',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Jerusalem'}).format(time)}. לא נשלחה הזמנה ליומן.`,now);
  }
  if(action==='close'){
    if(l.status!=='booked')throw new Error('קודם מתעדים תור.');
    return updateLead(state,id,{status:'closed',closedAt:now.toISOString()},'הפנייה סומנה כנסגרה. הכנסה תיספר רק באישור נפרד.',now);
  }
  if(action==='revenue'){
    if(l.status!=='closed')throw new Error('מאשרים הכנסה רק אחרי סגירה.');
    const minor=Number(value);if(!Number.isSafeInteger(minor)||minor<=0||minor>100000000)throw new Error('הזינו סכום תקין גדול מאפס.');
    if(l.revenueConfirmedAt)throw new Error('ההכנסה כבר תועדה. אין רישום כפול.');
    return updateLead(state,id,{revenueMinor:minor,revenueConfirmedAt:now.toISOString()},`אושרה הכנסה בסך ${(minor/100).toLocaleString('he-IL')} ₪.`,now);
  }
  throw new Error('הפעולה אינה מוכרת.');
}
export function importIntoGuest(state:GuestState,rows:ImportLead[],now=new Date()):{state:GuestState;inserted:number;updated:number;duplicates:number} {
  const groups=consolidateImportLeads(rows);let leads=[...state.leads], inserted=0, updated=0,duplicates=0;
  for(const g of groups){
    const ids=existingLeadIdsForContact(g,leads);
    if(ids.length>1)throw new Error('פרטי קשר מצביעים על שתי פניות שונות. תקנו את הכפילות לפני הייבוא.');
    const existing=leads.find(l=>l.id===ids[0]||l.external_ref===g.lead.external_ref);
    const next=toGuestLead(g.lead,false,now);
    if(existing){
      const patch=safeReimportPatch(existing,next) as Partial<GuestLead>;
      if(Object.keys(patch).length){updated++;leads=leads.map(l=>l.id===existing.id?{...l,...patch,trail:[...l.trail,trail('ייבוא חוזר עדכן הגבלות קשר בלי לאפס את ההתקדמות.',now)]}:l);}
      else duplicates++;
    }else{leads.push(next);inserted++;}
  }
  if(leads.length>MAX_LEADS)throw new Error(`מצב אורח מוגבל ל־${MAX_LEADS} פניות.`);
  return {state:{...state,leads,updatedAt:now.toISOString()},inserted,updated,duplicates:duplicates+(rows.length-groups.length)};
}
export function addChange(state:GuestState,change:BusinessChange,now=new Date()):GuestState {
  if(!change.title.trim()||!change.service.trim()||change.details.trim().length<4)throw new Error('השלימו שירות ותיאור עובדתי של השינוי.');
  if(change.type==='slot'&&(!change.starts_at||!Number.isFinite(new Date(change.starts_at).getTime())||new Date(change.starts_at)<=now))throw new Error('התור צריך להיות בעתיד.');
  if(!change.ends_at&&change.type!=='slot')throw new Error('צריך לציין עד מתי העדכון בתוקף.');
  if(change.ends_at&&(!Number.isFinite(new Date(change.ends_at).getTime())||new Date(change.ends_at)<=now))throw new Error('תאריך התוקף צריך להיות בעתיד.');
  return {...state,changes:[change,...state.changes],updatedAt:now.toISOString()};
}
export function results(state:GuestState,days=0,now=new Date()) {
  const since=days?now.getTime()-days*86400000:0;
  const inRange=(v?:string)=>!!v&&new Date(v).getTime()>=since;
  const sent=state.leads.filter(l=>inRange(l.sentAt)).length;
  const returned=state.leads.filter(l=>inRange(l.repliedAt)).length;
  const booked=state.leads.filter(l=>l.trail.some(t=>t.text.startsWith('תועד תור')&&new Date(t.at).getTime()>=since)).length;
  const closed=state.leads.filter(l=>inRange(l.closedAt)).length;
  const revenue=state.leads.filter(l=>inRange(l.revenueConfirmedAt)).reduce((sum,l)=>sum+(l.revenueMinor||0),0);
  return {sent,returned,booked,closed,revenue};
}
export function csvCell(value:unknown):string {let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s=`'${s}`;return `"${s.replace(/"/g,'""')}"`;}
export function exportGuestCsv(state:GuestState):string {
  const heads=['שם','טלפון','אימייל','שירות','מצב','סיבת עצירה','לא ליצור קשר','שווי','הכנסה שאושרה','תאריך קשר אחרון','הערות'];
  return '\uFEFF'+[heads,...state.leads.map(l=>[l.name,l.phone,l.email,l.service,displayStatus(state,l),l.stopped_reason_text,l.dnc?'כן':'לא',l.value_minor/100,l.revenueConfirmedAt?(l.revenueMinor||0)/100:'',l.last_contact_at,l.notes])].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
/** Validate untrusted local storage / backup data before it reaches the UI. */
export function parseGuest(raw:string):GuestState {
  const value:unknown=JSON.parse(raw);
  const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const text=(v:unknown,max=5000)=>typeof v==='string'&&v.length<=max;
  const date=(v:unknown)=>text(v,50)&&Number.isFinite(new Date(v as string).getTime());
  const optional=(v:unknown,check:(v:unknown)=>boolean)=>v==null||check(v);
  const err=()=>new Error('הגיבוי אינו תקין. נתוני האורח הקיימים לא הוחלפו.');
  if(!obj(value)||value.version!==1||!text(value.clinicName,100)||!text(value.mainService,100)||!date(value.createdAt)||!date(value.updatedAt)||!Array.isArray(value.leads)||!Array.isArray(value.changes)||value.leads.length>MAX_LEADS||value.changes.length>1000)throw err();
  const ids=new Set<string>();
  for(const l of value.leads){
    if(!obj(l)||!text(l.id,150)||ids.has(l.id as string)||!text(l.name,150)||!text(l.service,100)||!text(l.notes,5000)||!text(l.stopped_reason_text,2000)||!text(l.stopped_reason_code,50)||!Object.hasOwn(STATUS,String(l.status))||!Number.isSafeInteger(l.value_minor)||Number(l.value_minor)<0||Number(l.value_minor)>100000000||!date(l.created_at)||!date(l.updated_at)||!Array.isArray(l.trail)||l.trail.length>5000)throw err();
    for(const k of ['dnc','medical_escalation','needs_fix','is_demo'])if(typeof l[k]!=='boolean')throw err();
    for(const k of ['phone','email','branch','external_ref','preferred_time','response_text','draft','draftChangeId'])if(!optional(l[k],v=>text(v)))throw err();
    for(const k of ['last_contact_at','requested_contact_after','sentAt','repliedAt','bookedAt','closedAt','revenueConfirmedAt','snoozedUntil'])if(!optional(l[k],date))throw err();
    if(!optional(l.revenueMinor,v=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=100000000)||l.revenueConfirmedAt&&(!l.closedAt||!l.revenueMinor))throw err();
    if(l.dismissedChanges!==undefined&&(!Array.isArray(l.dismissedChanges)||!l.dismissedChanges.every(v=>text(v,200))))throw err();
    for(const t of l.trail)if(!obj(t)||!text(t.id,150)||!date(t.at)||!text(t.text,5000))throw err();
    ids.add(l.id as string);
  }
  for(const c of value.changes){
    if(!obj(c)||!text(c.id,150)||!Object.hasOwn(CHANGE_LABEL,String(c.type))||!text(c.service,100)||!text(c.title,200)||!text(c.details,2000)||!optional(c.branch,v=>text(v,100))||!date(c.created_at)||!optional(c.starts_at,date)||!optional(c.ends_at,date))throw err();
  }
  return value as unknown as GuestState;
}

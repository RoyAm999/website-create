/** Public, unsigned intake configuration. Never use its prices as a trusted transaction. */
export interface IntakeConfig { v: 1; name: string; phone: string; seat: number; minimum: number; mattress: number; cities: string[] }
export interface IntakeInput { seats: number; mattresses: number; material: string; city: string; timing: string; name: string; notes: string }
export const DEMO_CONFIG: IntakeConfig = { v: 1, name: 'סטודיו נקי · עסק לדוגמה', phone: '', seat: 100, minimum: 300, mattress: 200, cities: ['אשקלון','אשדוד','יבנה'] };
export const INITIAL_INPUT: IntakeInput = { seats: 3, mattresses: 0, material: 'בד רגיל', city: 'אשקלון', timing: 'השבוע', name: '', notes: '' };
export function businessPhone(value: string): string {
  const n=value.replace(/[\s()+-]/g,'');
  if (/^05\d{8}$/.test(n)) return '972'+n.slice(1);
  if (/^9725\d{8}$/.test(n)) return n;
  return '';
}
export function validateConfig(value: unknown, allowDemo=false): IntakeConfig {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('הקישור לא תקין.');
  const c=value as Partial<IntakeConfig>;
  if (c.v!==1 || typeof c.name!=='string' || c.name.trim().length<2 || c.name.length>60 || /[\r\n\x00-\x1f]/.test(c.name)) throw new Error('צריך שם עסק באורך 2–60 תווים.');
  if (typeof c.phone!=='string' || (!businessPhone(c.phone) && !(allowDemo&&c.phone===''))) throw new Error('צריך מספר נייד ישראלי תקין של העסק.');
  for (const key of ['seat','minimum','mattress'] as const) if (!Number.isInteger(c[key]) || Number(c[key])<1 || Number(c[key])>10000) throw new Error('המחירים חייבים להיות מספרים שלמים בין 1 ל־10,000.');
  if (!Array.isArray(c.cities) || c.cities.length<1 || c.cities.length>30 || c.cities.some(s=>typeof s!=='string'||!s.trim()||s.length>40||/[\r\n\x00-\x1f]/.test(s))) throw new Error('צריך 1–30 ערים, עד 40 תווים לכל עיר.');
  return { v:1,name:c.name.trim(),phone:businessPhone(c.phone),seat:c.seat!,minimum:c.minimum!,mattress:c.mattress!,cities:[...new Set(c.cities.map(s=>s.trim()))] };
}
export function packConfig(config: IntakeConfig): string {
  const bytes=new TextEncoder().encode(JSON.stringify(validateConfig(config)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function unpackConfig(encoded: string): IntakeConfig {
  if (encoded.length>8000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('הקישור פגום. בקשו מהעסק קישור חדש.');
  try { const bytes=Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));return validateConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))); }
  catch { throw new Error('הקישור פגום. בקשו מהעסק קישור חדש.'); }
}
export function estimate(c:IntakeConfig,i:IntakeInput): { amount:number|null; reason:string } {
  validateConfig(c,true);
  if (!Number.isInteger(i.seats)||i.seats<1||i.seats>8||!Number.isInteger(i.mattresses)||i.mattresses<0||i.mattresses>3) throw new Error('כמות הפריטים אינה תקינה.');
  if (!c.cities.includes(i.city)) return {amount:null,reason:'העיר מחוץ לאזור השירות שהוגדר. צריך לבדוק הגעה ומחיר עם העסק.'};
  if (i.material!=='בד רגיל') return {amount:null,reason:'סוג הריפוד דורש בדיקה אישית. לא נחשב מחיר בלי שהעסק יבדוק.'};
  return {amount:Math.max(c.minimum,i.seats*c.seat+i.mattresses*c.mattress),reason:'אומדן לפי המחירון שבקישור, בכפוף לבדיקת התמונות ואישור העסק. זו אינה הזמנה או התחייבות למחיר.'};
}
export function requestText(c:IntakeConfig,i:IntakeInput):string {
  const e=estimate(c,i);
  if (!i.name.trim()||i.name.trim().length>60||/[\r\n\x00-\x1f]/.test(i.name)) throw new Error('צריך שם פרטי תקין, עד 60 תווים.');
  if (!i.city.trim()||i.city.length>50 || !['בהקדם','השבוע','שבוע הבא','גמיש'].includes(i.timing) || i.notes.length>600) throw new Error('צריך לבדוק את פרטי הבקשה.');
  return `שלום ${c.name}, אני ${i.name.trim()}. אשמח לבדיקת מחיר לניקוי:\nספה: ${i.seats} מושבים\nריפוד: ${i.material}\nמזרנים זוגיים: ${i.mattresses}\nעיר: ${i.city}\nמועד מועדף: ${i.timing}\n${e.amount===null?'נדרשת בדיקה אישית, ללא אומדן מחיר.':`אומדן שהוצג בקישור: ₪${e.amount} (לא מחיר מאושר).`}\n${i.notes.trim()?`הערות: ${i.notes.trim()}\n`:''}אצרף תמונה בוואטסאפ כדי שתוכלו לאשר מחיר. זו בקשת בדיקה בלבד, לא הזמנה סופית.`;
}
export function whatsappLink(phone:string,text:string):string {
  const normalized=businessPhone(phone);if(!normalized)throw new Error('לא הוגדר מספר עסק תקין.');
  return `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`;
}

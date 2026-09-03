export const CLINIC_TIME_ZONE = "Asia/Jerusalem";

type ClinicDateFormatOptions = Omit<Intl.DateTimeFormatOptions, "timeZone">;

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DATE");
  return date;
}

function parts(value: Date) {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => formatted.find((item) => item.type === type)?.value || "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    second: Number(read("second")),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatClinicDate(value: Date | string, options: ClinicDateFormatOptions): string {
  return new Intl.DateTimeFormat("he-IL", { ...options, timeZone: CLINIC_TIME_ZONE }).format(asDate(value));
}

export function clinicDateInputValue(value: Date = new Date()): string {
  const local = parts(asDate(value));
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

export function clinicDateTimeInputValue(value: Date = new Date()): string {
  const local = parts(asDate(value));
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;
}

/** Converts a wall-clock time entered by an Israeli clinic into an absolute instant. */
export function clinicLocalDateTimeToIso(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error("INVALID_LOCAL_DATE_TIME");

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  if (
    target.month < 1 || target.month > 12 || target.day < 1 || target.day > 31
    || target.hour < 0 || target.hour > 23 || target.minute < 0 || target.minute > 59
  ) throw new Error("INVALID_LOCAL_DATE_TIME");

  let instant = new Date(targetAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = parts(instant);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
    );
    instant = new Date(instant.getTime() + targetAsUtc - renderedAsUtc);
  }

  const verified = parts(instant);
  if (
    verified.year !== target.year || verified.month !== target.month || verified.day !== target.day
    || verified.hour !== target.hour || verified.minute !== target.minute
  ) throw new Error("INVALID_LOCAL_DATE_TIME");
  return instant.toISOString();
}

export function clinicDateToMiddayIso(value: string): string {
  return clinicLocalDateTimeToIso(`${value}T12:00`);
}

export function tomorrowClinicMorning(now: Date = new Date()): string {
  const [year, month, day] = clinicDateInputValue(now).split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const date = `${tomorrow.getUTCFullYear()}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(tomorrow.getUTCDate())}`;
  return clinicLocalDateTimeToIso(`${date}T09:00`);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  clinicDateInputValue,
  clinicDateTimeInputValue,
  clinicDateToMiddayIso,
  clinicLocalDateTimeToIso,
  formatClinicDate,
  tomorrowClinicMorning,
} from "../lib/clinic-time";

test("formats product dates in the clinic time zone", () => {
  const instant = new Date("2026-09-03T21:30:00Z");
  assert.equal(clinicDateInputValue(instant), "2026-09-04");
  assert.equal(clinicDateTimeInputValue(instant), "2026-09-04T00:30");
  assert.match(formatClinicDate(instant, { day: "numeric", month: "numeric", year: "numeric" }), /4\.9\.2026/);
});

test("converts Israeli wall-clock inputs across daylight saving time", () => {
  assert.equal(clinicLocalDateTimeToIso("2026-09-10T18:00"), "2026-09-10T15:00:00.000Z");
  assert.equal(clinicLocalDateTimeToIso("2026-12-10T18:00"), "2026-12-10T16:00:00.000Z");
  assert.equal(clinicDateToMiddayIso("2026-09-10"), "2026-09-10T09:00:00.000Z");
});

test("tomorrow morning follows the clinic calendar rather than the device calendar", () => {
  assert.equal(tomorrowClinicMorning(new Date("2026-09-03T21:30:00Z")), "2026-09-05T06:00:00.000Z");
});

test("rejects malformed local date-times", () => {
  assert.throws(() => clinicLocalDateTimeToIso("not-a-date"), /INVALID_LOCAL_DATE_TIME/);
  assert.throws(() => clinicLocalDateTimeToIso("2026-13-10T18:00"), /INVALID_LOCAL_DATE_TIME/);
});

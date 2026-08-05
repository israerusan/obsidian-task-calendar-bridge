import { zoneOffsetMinutes } from "./dates";

/**
 * VTIMEZONE generation from `Intl` alone.
 *
 * A recurring event cannot be pinned to a UTC instant: a 09:00 weekly standup
 * would become 08:00 the moment the zone crosses a DST boundary. The only
 * correct way to say "09:00 in this zone, every week" is
 * `DTSTART;TZID=<zone>:<local time>` plus a VTIMEZONE that defines the zone.
 *
 * 1.1.0 avoided VTIMEZONE because a hand-maintained rule table goes stale. That
 * is not necessary: the runtime already ships a tz database behind `Intl`, so
 * the transitions are discovered by probing it at export time and the rules are
 * always as current as the device.
 */

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Transition {
  /** The UTC instant the offset changes. */
  at: number;
  /** Minutes ahead of UTC before the change. */
  from: number;
  /** Minutes ahead of UTC after the change. */
  to: number;
}

/**
 * Every offset change in `[fromMs, toMs)`, located to the minute.
 *
 * Walks a day at a time and binary-searches the day that straddles a change.
 * Returns undefined when the runtime does not know the zone.
 */
function findTransitions(timeZone: string, fromMs: number, toMs: number): Transition[] | undefined {
  const transitions: Transition[] = [];
  let cursor = fromMs;
  let offset = zoneOffsetMinutes(cursor, timeZone);
  if (offset === undefined) return undefined;

  while (cursor < toMs) {
    const next = Math.min(cursor + DAY_MS, toMs);
    const nextOffset = zoneOffsetMinutes(next, timeZone);
    if (nextOffset === undefined) return undefined;

    if (nextOffset !== offset) {
      let before = cursor;
      let after = next;
      while (after - before > MIN_MS) {
        const mid = before + Math.floor((after - before) / 2 / MIN_MS) * MIN_MS;
        if (mid === before) break;
        if (zoneOffsetMinutes(mid, timeZone) === offset) before = mid;
        else after = mid;
      }
      transitions.push({ at: after, from: offset, to: nextOffset });
      offset = nextOffset;
      // More than a DST pair means an irregular year (a zone that changed its
      // rules, or one whose transitions follow a lunar calendar). Give up rather
      // than describe it with a yearly rule that would be wrong.
      if (transitions.length > 2) return transitions;
    }

    cursor = next;
  }

  return transitions;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `-0430`, the RFC 5545 UTC-offset form. Handles the 45-minute zones. */
function offsetValue(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** The instant rendered as wall time in the offset that was in force before it. */
function localStamp(at: number, fromOffsetMinutes: number): string {
  const d = new Date(at + fromOffsetMinutes * MIN_MS);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

/**
 * `FREQ=YEARLY;BYMONTH=3;BYDAY=2SU` — the nth weekday of a month, counting back
 * from the end when the date falls in the last possible week (which is how "the
 * last Sunday in March" has to be expressed for it to hold in every year).
 */
function yearlyRule(at: number, fromOffsetMinutes: number): string {
  const d = new Date(at + fromOffsetMinutes * MIN_MS);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const weekday = WEEKDAY_CODES[d.getUTCDay()];
  const monthLength = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
  const ordinal = day + 7 > monthLength ? -1 : Math.floor((day - 1) / 7) + 1;
  return `FREQ=YEARLY;BYMONTH=${month};BYDAY=${ordinal}${weekday}`;
}

/**
 * Whether another year's transitions are described by the same yearly rule:
 * the same nth weekday, the same offsets, and the same wall-clock time of day.
 */
function matchesRule(anchor: Transition[], other: Transition[] | undefined): boolean {
  if (other === undefined || other.length !== anchor.length) return false;
  for (let i = 0; i < anchor.length; i++) {
    if (anchor[i].from !== other[i].from || anchor[i].to !== other[i].to) return false;
    if (yearlyRule(anchor[i].at, anchor[i].from) !== yearlyRule(other[i].at, other[i].from)) return false;
    // The time of day has to match too, or the rule reproduces the right date at
    // the wrong hour. localStamp is YYYYMMDDTHHMMSS, so slice(8) is the time.
    if (localStamp(anchor[i].at, anchor[i].from).slice(8) !== localStamp(other[i].at, other[i].from).slice(8)) return false;
  }
  return true;
}

/** Memoised: an export asks for the same zone and year every time. */
const CACHE = new Map<string, string[] | undefined>();

/**
 * A VTIMEZONE for `timeZone` describing the rules in force during `year`, or
 * undefined when the zone is unknown or its year is irregular enough that a
 * yearly rule would misdescribe it. The caller falls back to UTC instants there.
 */
export function buildVtimezone(timeZone: string, year: number): string[] | undefined {
  if (!timeZone) return undefined;
  // Probing a zone costs a few hundred Intl formatter calls on the main thread;
  // an export asks the same question every time it runs.
  const key = `${timeZone}|${year}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const built = computeVtimezone(timeZone, year);
  CACHE.set(key, built);
  return built;
}

function computeVtimezone(timeZone: string, year: number): string[] | undefined {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const transitions = findTransitions(timeZone, start, end);
  if (transitions === undefined) return undefined;

  // A zone that never changes offset: one STANDARD component, no rule.
  // Dated a year back for the same reason the DST pair is — an observance only
  // applies from its DTSTART onward, and an event can predate the anchor year.
  if (transitions.length === 0) {
    const offset = zoneOffsetMinutes(start, timeZone);
    if (offset === undefined) return undefined;
    return [
      "BEGIN:VTIMEZONE",
      `TZID:${timeZone}`,
      "BEGIN:STANDARD",
      `DTSTART:${year - 1}0101T000000`,
      `TZOFFSETFROM:${offsetValue(offset)}`,
      `TZOFFSETTO:${offsetValue(offset)}`,
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }

  if (transitions.length !== 2) return undefined;

  // A yearly rule inferred from one year's dates is a guess until it is checked.
  // Zones whose transitions follow a lunar calendar (Morocco and Iran have both
  // done this) produce a perfectly plausible "third Sunday in March" that is
  // simply wrong in every other year, and the resulting VTIMEZONE would put
  // events an hour out for a whole DST season. Check the years either side, and
  // fall back to resolved UTC instants when the rule does not hold in all three.
  const previous = findTransitions(timeZone, Date.UTC(year - 1, 0, 1), Date.UTC(year, 0, 1));
  const next = findTransitions(timeZone, Date.UTC(year + 1, 0, 1), Date.UTC(year + 2, 0, 1));
  if (!matchesRule(transitions, previous) || !matchesRule(transitions, next)) return undefined;

  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  // DTSTART comes from the EARLIER year, not the anchor year. An observance only
  // applies from its DTSTART onward, so anchoring both on the current year left
  // any event between 1 January and that year's first transition referring to a
  // zone with no observance covering it. Starting a year earlier closes the gap,
  // and the yearly rule — now verified across three years — carries it forward.
  for (const transition of previous as Transition[]) {
    // Southern-hemisphere zones enter daylight time in October, so the pair is
    // ordered by which direction the offset moves, never by which comes first.
    const daylight = transition.to > transition.from;
    lines.push(daylight ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD");
    lines.push(`DTSTART:${localStamp(transition.at, transition.from)}`);
    lines.push(`TZOFFSETFROM:${offsetValue(transition.from)}`);
    lines.push(`TZOFFSETTO:${offsetValue(transition.to)}`);
    lines.push(`RRULE:${yearlyRule(transition.at, transition.from)}`);
    lines.push(daylight ? "END:DAYLIGHT" : "END:STANDARD");
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

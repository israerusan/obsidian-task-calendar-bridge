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
 * Whether another year's transitions have the same shape as the anchor year's: as many of them,
 * the same offsets, the same month and weekday, and the same wall-clock time of day. Shape alone
 * does not fix the day of the month — that is what `ruleFor` derives across all the years.
 */
function sameShape(anchor: Transition[], other: Transition[] | undefined): boolean {
  if (other === undefined || other.length !== anchor.length) return false;
  for (let i = 0; i < anchor.length; i++) {
    if (anchor[i].from !== other[i].from || anchor[i].to !== other[i].to) return false;
    const a = new Date(anchor[i].at + anchor[i].from * MIN_MS);
    const o = new Date(other[i].at + other[i].from * MIN_MS);
    if (a.getUTCMonth() !== o.getUTCMonth() || a.getUTCDay() !== o.getUTCDay()) return false;
    // The time of day has to match too, or the rule reproduces the right date at
    // the wrong hour. localStamp is YYYYMMDDTHHMMSS, so slice(8) is the time.
    if (localStamp(anchor[i].at, anchor[i].from).slice(8) !== localStamp(other[i].at, other[i].from).slice(8)) return false;
  }
  return true;
}

/**
 * One yearly RRULE that reproduces the `index`th transition in every one of `years`, or undefined.
 *
 * Two forms, because zones are written both ways. Most are an nth (or last) weekday of a month —
 * `BYDAY=2SU`, `BYDAY=-1SU`. Some are "the weekday on or after a day of the month": Israel starts
 * daylight time on the Friday before the last Sunday of March, which is the last Friday in some
 * years and not in others (2026: 27 March, the last Friday; 2028: 24 March, a week before the last
 * Friday). Three consecutive years can agree with `-1FR` by accident; the dates across the whole
 * verified span cannot, and they pin the window — `BYMONTHDAY=23,…,29;BYDAY=FR` — exactly.
 */
function ruleFor(index: number, years: Transition[][]): string | undefined {
  const anchor = years[0][index];
  const nth = yearlyRule(anchor.at, anchor.from);
  if (years.every((transitions) => yearlyRule(transitions[index].at, transitions[index].from) === nth)) return nth;

  const days = years.map((transitions) => new Date(transitions[index].at + transitions[index].from * MIN_MS).getUTCDate());
  const first = Math.max(...days) - 6;
  if (first < 1 || Math.min(...days) < first) return undefined;
  const d = new Date(anchor.at + anchor.from * MIN_MS);
  const window = Array.from({ length: 7 }, (_, i) => first + i).join(",");
  return `FREQ=YEARLY;BYMONTH=${d.getUTCMonth() + 1};BYDAY=${WEEKDAY_CODES[d.getUTCDay()]};BYMONTHDAY=${window}`;
}

/**
 * How far ahead a rule must hold before it is written as an unbounded yearly RRULE. Three years
 * was not enough to tell "last Friday" from "Friday before the last Sunday"; twelve cover every
 * alignment of weekdays to dates, so a rule that survives them is the zone's rule, not a
 * coincidence. A change the tz database already knows about inside the span fails the check too.
 */
const FORWARD_YEARS = 10;
/**
 * The earliest year observances may start. No fixed look-back: the walk back stops at the zone's
 * last rule change anyway — which bounds the cost — and a stable zone (India since 1945) should
 * cover a 1980 series. Before 1900 the tz database is local mean time and not worth describing.
 */
const MIN_YEAR = 1900;

/** Memoised per zone and year: every export asks the same questions. */
const YEAR_CACHE = new Map<string, Transition[] | undefined>();
const CACHE = new Map<string, ZoneDefinition | undefined>();

function transitionsIn(timeZone: string, year: number): Transition[] | undefined {
  const key = `${timeZone}|${year}`;
  if (YEAR_CACHE.has(key)) return YEAR_CACHE.get(key);
  const found = findTransitions(timeZone, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
  YEAR_CACHE.set(key, found);
  return found;
}

export interface ZoneDefinition {
  /** The VTIMEZONE component, BEGIN to END. */
  lines: string[];
  /**
   * The first date (`YYYY-MM-DD`) its observances are guaranteed to cover. They begin at the first
   * transition of their start year, so everything from 1 January of the following year is inside
   * them (from 1 January of the start year itself for a zone with no transitions).
   */
  coversFrom: string;
}

/**
 * A VTIMEZONE for `timeZone` describing the rules in force during `year`, or
 * undefined when the zone is unknown or its rules are too irregular to describe
 * with a yearly rule. The caller falls back to UTC instants there.
 */
export function buildVtimezone(timeZone: string, year: number): string[] | undefined {
  return buildZoneDefinition(timeZone, year)?.lines;
}

/**
 * The VTIMEZONE plus the span it covers.
 *
 * `earliestYear` asks for observances reaching back that far — the year of the oldest repeating
 * timed task, whose first occurrences would otherwise name a zone with no observance in force.
 * They reach back only as far as the current rule actually held: a zone that changed its rules
 * (the US in 2007) is described from the change onward, never with today's rule painted over a
 * past it does not match.
 */
export function buildZoneDefinition(timeZone: string, year: number, earliestYear: number = year - 1): ZoneDefinition | undefined {
  if (!timeZone) return undefined;
  const floor = Math.max(Math.min(earliestYear, year - 1), MIN_YEAR);
  // Probing a zone costs a few hundred Intl formatter calls per year on the main
  // thread; an export asks the same question every time it runs.
  const key = `${timeZone}|${year}|${floor}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const built = computeZoneDefinition(timeZone, year, floor);
  CACHE.set(key, built);
  return built;
}

function computeZoneDefinition(timeZone: string, year: number, floor: number): ZoneDefinition | undefined {
  return yearlyZone(timeZone, year, floor) ?? settledZone(timeZone, year);
}

/**
 * A zone that has stopped changing, described by its actual last transitions.
 *
 * British Columbia moved to permanent daylight time in 2026: one transition that year, none
 * after. No yearly rule describes that — 2026 is not a DST pair and 2025 does not match 2027 —
 * so it fell back, and every repeating Vancouver event was written as a floating time. But a
 * zone that settles is the easiest one there is to describe exactly: each recent transition as
 * a one-off observance (no RRULE), and the last one's offset simply holds from then on.
 *
 * Only for a zone that is settled well inside the verified span. One still changing near its end
 * would have its last offset frozen forever, which is a guess, not the zone.
 */
function settledZone(timeZone: string, year: number): ZoneDefinition | undefined {
  const changes: Transition[] = [];
  let lastChangeYear = -1;
  for (let y = year - 1; y <= year + FORWARD_YEARS; y++) {
    const transitions = transitionsIn(timeZone, y);
    if (transitions === undefined) return undefined;
    if (transitions.length > 0) {
      changes.push(...transitions);
      lastChangeYear = y;
    }
  }
  // At least five quiet years at the end of the span, and a handful of changes — a zone still
  // flipping every year is the yearly-rule case, or irregular, not settled.
  if (changes.length === 0 || changes.length > 8 || lastChangeYear > year + FORWARD_YEARS - 5) return undefined;

  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  // The offset in force from the start of last year until the first change.
  const initial = changes[0].from;
  lines.push("BEGIN:STANDARD", `DTSTART:${year - 1}0101T000000`, `TZOFFSETFROM:${offsetValue(initial)}`, `TZOFFSETTO:${offsetValue(initial)}`, "END:STANDARD");
  for (const change of changes) {
    const daylight = change.to > change.from;
    lines.push(daylight ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD");
    lines.push(`DTSTART:${localStamp(change.at, change.from)}`);
    lines.push(`TZOFFSETFROM:${offsetValue(change.from)}`);
    lines.push(`TZOFFSETTO:${offsetValue(change.to)}`);
    lines.push(daylight ? "END:DAYLIGHT" : "END:STANDARD");
  }
  lines.push("END:VTIMEZONE");
  // From 1 January of the anchor year: last year's local new year can fall in the hours before
  // UTC midnight that were never probed.
  return { lines, coversFrom: `${year}-01-01` };
}

function yearlyZone(timeZone: string, year: number, floor: number): ZoneDefinition | undefined {
  const anchor = transitionsIn(timeZone, year);
  if (anchor === undefined) return undefined;
  // Exactly a DST pair, or no change at all. Anything else is an irregular year
  // (a zone that changed its rules, or one whose transitions follow a lunar
  // calendar — Morocco suspends DST for Ramadan) and is not a yearly rule.
  if (anchor.length !== 0 && anchor.length !== 2) return undefined;

  // A yearly rule inferred from one year's dates is a guess until it is checked.
  // Zones whose transitions follow a lunar calendar produce a perfectly plausible
  // "third Sunday in March" that is simply wrong in other years, and the resulting
  // VTIMEZONE would put events an hour out for a whole DST season. Check the
  // whole span, and fall back to resolved UTC instants when the rule does not hold.
  const forward: Transition[][] = [];
  for (let y = year - 1; y <= year + FORWARD_YEARS; y++) {
    const transitions = transitionsIn(timeZone, y);
    if (!sameShape(anchor, transitions)) return undefined;
    forward.push(transitions as Transition[]);
  }

  // Observances start a year before the anchor at the latest: an observance only applies from its
  // DTSTART onward, and anchoring on the current year left everything before this year's first
  // transition with no observance at all. Further back when an old repeating task needs it, for
  // as long as the zone's rule held.
  let start = year - 1;
  let years = forward;
  while (start - 1 >= floor) {
    const earlier = transitionsIn(timeZone, start - 1);
    if (!sameShape(anchor, earlier)) break;
    years = [earlier as Transition[], ...years];
    start--;
  }

  if (anchor.length === 0) {
    const offset = zoneOffsetMinutes(Date.UTC(year, 0, 1), timeZone);
    if (offset === undefined) return undefined;
    // Years are probed in UTC, but the observance starts at LOCAL midnight on 1 January, which
    // east of UTC is hours earlier. Nepal moved from +05:30 to +05:45 at exactly local midnight
    // on 1 January 1986 — inside that unprobed sliver — so a definition starting 19860101 claimed
    // an offset that was not yet in force. Start only where the offset really held.
    while (start < year && zoneOffsetMinutes(Date.UTC(start, 0, 1) - offset * MIN_MS, timeZone) !== offset) start++;
    return {
      lines: [
        "BEGIN:VTIMEZONE",
        `TZID:${timeZone}`,
        "BEGIN:STANDARD",
        `DTSTART:${start}0101T000000`,
        `TZOFFSETFROM:${offsetValue(offset)}`,
        `TZOFFSETTO:${offsetValue(offset)}`,
        "END:STANDARD",
        "END:VTIMEZONE",
      ],
      coversFrom: `${start}-01-01`,
    };
  }

  // The rule has to reproduce every year from the start onward. Same-shaped years can still
  // follow a different rule — the UK ended DST on the fourth Sunday of October until 1995, not
  // the last — so the oldest years are dropped one at a time until a rule holds for all that
  // remain. Only the walked-back years are ever dropped; the forward span decides the zone.
  // No Intl calls here: every year's transitions are already cached.
  let rules = anchor.map((_, i) => ruleFor(i, years));
  while (rules.some((rule) => rule === undefined) && start < year - 1) {
    start++;
    years = years.slice(1);
    rules = anchor.map((_, i) => ruleFor(i, years));
  }
  if (rules.some((rule) => rule === undefined)) return undefined;

  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  years[0].forEach((transition, i) => {
    // Southern-hemisphere zones enter daylight time in October, so the pair is
    // ordered by which direction the offset moves, never by which comes first.
    const daylight = transition.to > transition.from;
    lines.push(daylight ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD");
    lines.push(`DTSTART:${localStamp(transition.at, transition.from)}`);
    lines.push(`TZOFFSETFROM:${offsetValue(transition.from)}`);
    lines.push(`TZOFFSETTO:${offsetValue(transition.to)}`);
    lines.push(`RRULE:${rules[i] as string}`);
    lines.push(daylight ? "END:DAYLIGHT" : "END:STANDARD");
  });
  lines.push("END:VTIMEZONE");
  return { lines, coversFrom: `${start + 1}-01-01` };
}

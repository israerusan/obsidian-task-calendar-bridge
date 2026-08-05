import { stripTrailingNotes } from "./text";
import type { Recurrence } from "./types";

/**
 * Translates the Obsidian Tasks plugin's recurrence phrases into an RFC 5545
 * RRULE. Deliberately a documented subset: anything not understood returns
 * undefined so the caller can report it instead of exporting a wrong rule.
 * A silently mis-scheduled repeating event is worse than a reported skip.
 */

// Maps, not plain objects: `UNIT_FREQ["constructor"]` resolved up the prototype
// chain to a function and produced `RRULE:FREQ=function Object() {…}`, which
// makes the entire calendar file unparseable.
const WEEKDAYS = new Map<string, string>([
  ["sunday", "SU"], ["sundays", "SU"], ["sun", "SU"],
  ["monday", "MO"], ["mondays", "MO"], ["mon", "MO"],
  ["tuesday", "TU"], ["tuesdays", "TU"], ["tue", "TU"], ["tues", "TU"],
  ["wednesday", "WE"], ["wednesdays", "WE"], ["wed", "WE"], ["weds", "WE"],
  ["thursday", "TH"], ["thursdays", "TH"], ["thu", "TH"], ["thur", "TH"], ["thurs", "TH"],
  ["friday", "FR"], ["fridays", "FR"], ["fri", "FR"],
  ["saturday", "SA"], ["saturdays", "SA"], ["sat", "SA"],
]);

/** `first Monday`, `last Friday` — the ordinal prefixes of a monthly BYDAY. */
const ORDINALS = new Map<string, number>([
  ["first", 1], ["1st", 1],
  ["second", 2], ["2nd", 2],
  ["third", 3], ["3rd", 3],
  ["fourth", 4], ["4th", 4],
  ["last", -1],
]);

const UNIT_FREQ = new Map<string, string>([
  ["day", "DAILY"], ["days", "DAILY"],
  ["week", "WEEKLY"], ["weeks", "WEEKLY"],
  ["month", "MONTHLY"], ["months", "MONTHLY"],
  ["year", "YEARLY"], ["years", "YEARLY"],
]);

export function parseRecurrence(input: string): Recurrence | undefined {
  // A trailing tag, block id, or parenthetical is a comment on the task, not
  // part of the cadence: `🔁 every week on Monday #work` used to be reported as
  // an untranslatable rule and silently downgraded to a one-off event.
  const source = stripTrailingNotes(input);
  const text = source
    .toLowerCase()
    // "when done" changes when the *next* task is created, not the calendar
    // cadence, so it is stripped rather than treated as unsupported.
    .replace(/\bwhen\s+done\b/g, "")
    .trim();
  if (!text) return undefined;

  const body = text
    .replace(/^every\s*/, "")
    // "every other week" is ordinary English for a fortnight and was reported as
    // untranslatable; "every fortnight" likewise.
    .replace(/^other\s+/, "2 ")
    .replace(/^fortnight(s)?$/, "2 weeks")
    .trim();
  if (!body) return undefined;

  if (/^weekday(s)?$/.test(body)) {
    return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", source };
  }

  // "every 2 weeks on monday, friday" / "every month on the 15th" / "every monday"
  const match = /^(?:(\d+)\s+)?([a-z]+)(?:\s+(.*))?$/.exec(body);
  if (!match) return undefined;

  const interval = match[1] ? Number(match[1]) : 1;
  if (!Number.isFinite(interval) || interval < 1 || interval > 999) return undefined;
  const unitWord = match[2];
  const rest = (match[3] ?? "").trim();

  // A bare weekday means weekly on that day: "every monday", "every other
  // friday", "every monday and friday", "every 2 mondays".
  const bareWeekday = WEEKDAYS.get(unitWord);
  if (bareWeekday) {
    const modifier = rest ? parseWeekdayList(`${unitWord} and ${rest}`) : `BYDAY=${bareWeekday}`;
    if (!modifier) return undefined;
    return { rrule: withInterval("WEEKLY", interval, modifier), source };
  }

  const freq = UNIT_FREQ.get(unitWord);
  if (!freq) return undefined;

  if (!rest) return { rrule: withInterval(freq, interval), source };

  const modifier = parseModifier(freq, rest);
  if (!modifier) return undefined;
  return { rrule: withInterval(freq, interval, modifier), source };
}

function withInterval(freq: string, interval: number, modifier?: string): string {
  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (modifier) parts.push(modifier);
  return parts.join(";");
}

function parseModifier(freq: string, rest: string): string | undefined {
  const cleaned = rest.replace(/^on\s+(the\s+)?/, "").trim();
  if (!cleaned) return undefined;

  if (freq === "WEEKLY") return parseWeekdayList(cleaned);

  if (freq === "MONTHLY") {
    if (/^last(\s+day)?$/.test(cleaned)) return "BYMONTHDAY=-1";
    const day = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(cleaned);
    if (day) {
      const value = Number(day[1]);
      if (value >= 1 && value <= 31) return `BYMONTHDAY=${value}`;
    }
    // "every month on the first Monday" / "on the last Friday".
    const ordinal = /^(\S+)\s+(\S+)$/.exec(cleaned);
    if (ordinal) {
      const position = ORDINALS.get(ordinal[1]);
      const weekday = WEEKDAYS.get(ordinal[2]);
      if (position !== undefined && weekday !== undefined) return `BYDAY=${position}${weekday}`;
    }
    return undefined;
  }

  // Daily and yearly modifiers are not translated; report rather than guess.
  return undefined;
}

/**
 * `monday, friday` / `mon and fri` -> `BYDAY=MO,FR`.
 *
 * Every token has to resolve. Dropping the ones it did not recognise turned
 * "every week on Monday, Funday" into a Monday-only rule — a silently different
 * schedule, which is the one outcome this module exists to prevent.
 */
function parseWeekdayList(text: string): string | undefined {
  const tokens = text
    .split(/\s*(?:,|and)\s*/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;

  const days: string[] = [];
  for (const token of tokens) {
    const day = WEEKDAYS.get(token);
    if (day === undefined) return undefined;
    days.push(day);
  }

  // Preserve calendar order and drop duplicates.
  const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return `BYDAY=${order.filter((day) => days.includes(day)).join(",")}`;
}

/**
 * Obsidian tags take any Unicode letter, not just ASCII — `#café`, `#仕事` and
 * `#работа` are all real tags. The ASCII-only class this replaces truncated
 * `#café` to the tag `caf` and left a stray `é` sitting in the calendar event's
 * title, and dropped `#仕事` entirely while leaving the whole `#仕事` in the
 * title. Combining marks are included so a decomposed `e` + U+0301 behaves the
 * same as a precomposed `é`.
 *
 * Deliberately letters, numbers, `_`, `-` and `/` only — Obsidian's documented
 * set. Adding emoji looked generous but made `#work🎉` a single tag called
 * `work🎉`, which changed the task's title and therefore its calendar identity;
 * a decorative emoji after a tag is far more common than an emoji tag.
 *
 * A tag must contain at least one character that is not a digit, so `#42` stays
 * an issue number rather than becoming a tag — hence the three-part shape.
 *
 * Lives here rather than in parse.ts because both the parser and this file's
 * trailing-note trimming have to agree on exactly what a tag is: when they
 * disagreed, half a tag was stripped and half was left in the value.
 */
const TAG_CHAR = "\\p{L}\\p{N}\\p{M}_/-";
const TAG_REQUIRED = "\\p{L}\\p{M}_/-";
export const TAG_BODY = `[${TAG_CHAR}]*[${TAG_REQUIRED}][${TAG_CHAR}]*`;
/** Anchored to a whitespace boundary so `C#` and `note.md#heading` are left alone. */
export const TAG_PATTERN = `(?:^|\\s)#(${TAG_BODY})`;

const TRAILING_TAGS = new RegExp(`(?:\\s+#${TAG_BODY})+$`, "u");

/**
 * Removes a trailing comment, tag, or block id from an inline field value —
 * `45m (about an hour)`, `every week on Monday #work`, `1h ^abc123`.
 *
 * People put these at the end of a task line constantly. Treating them as part
 * of the value silently discarded the duration or downgraded a repeating event
 * to a one-off, so the trimming happens once, here, for every field that takes
 * free text.
 */
export function stripTrailingNotes(value: string): string {
  return value
    .trim()
    .replace(/\s*\^[A-Za-z0-9-]+$/, "")
    .replace(TRAILING_TAGS, "")
    .replace(/\s*\([^)]*\)$/, "")
    .trim();
}

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
    .replace(/(?:\s+#[A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)+$/, "")
    .replace(/\s*\([^)]*\)$/, "")
    .trim();
}

import { parseTasksFromMarkdown, type ParseOptions, type ParseResult } from "../core";

/**
 * Parsed notes, kept until they change.
 *
 * The cache key is the note's path plus its modification time plus a fingerprint of the parse
 * options, because flipping a Pro toggle changes what the same bytes mean — a task that was
 * excluded as completed becomes an event, and a repeat rule that was reported as unavailable
 * becomes a real recurrence.
 *
 * Bounded on purpose: one entry per Markdown file in the vault is unbounded by design, and each
 * holds every task and skip record that file produced.
 */

export interface NoteRef {
  path: string;
  mtime: number;
}

export interface ParseIndexOptions {
  read: (note: NoteRef) => Promise<string>;
  /** Entries kept before the oldest are dropped. */
  limit?: number;
}

const DEFAULT_LIMIT = 5000;

interface Entry {
  mtime: number;
  optionsKey: string;
  result: ParseResult;
}

export class ParseIndex {
  private readonly cache = new Map<string, Entry>();
  private readonly read: (note: NoteRef) => Promise<string>;
  private readonly limit: number;

  constructor(options: ParseIndexOptions) {
    this.read = options.read;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  async parse(note: NoteRef, options: ParseOptions): Promise<ParseResult> {
    const optionsKey = `${options.includeCompleted}|${options.includeRecurrence}|${options.includeReminders}`;
    const cached = this.cache.get(note.path);
    if (cached && cached.mtime === note.mtime && cached.optionsKey === optionsKey) return cached.result;

    // Sample the mtime BEFORE reading. Reading it afterwards paired the new mtime with old
    // content when the note changed mid-export, caching stale tasks against a fresh stamp.
    const mtime = note.mtime;
    const markdown = await this.read(note);
    const result = parseTasksFromMarkdown(markdown, note.path, options);
    this.cache.set(note.path, { mtime, optionsKey, result });
    this.trim();
    return result;
  }

  forget(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private trim(): void {
    if (this.cache.size <= this.limit) return;
    // Map iterates in insertion order, so the oldest entries go first.
    for (const key of this.cache.keys()) {
      this.cache.delete(key);
      if (this.cache.size <= this.limit) break;
    }
  }
}

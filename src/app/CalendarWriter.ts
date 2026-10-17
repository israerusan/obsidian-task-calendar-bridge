import { matchesSignature } from "../core";
import type { ExternalStore, FileStore, Lifecycle } from "./ports";

/**
 * The single writer.
 *
 * Both destinations — the file in the vault and the copy outside it — obeyed the same rule,
 * written out twice in two different methods: *skip the write when the content is unchanged AND
 * the destination is still there*. The second half of that rule is not an optimisation. Without
 * it, deleting the calendar by hand never brought it back, because the plugin still believed the
 * file it had written was sitting where it left it.
 *
 * Owning both means the rule exists once, and the two ideas it is built from — content identity
 * and destination presence — are named rather than repeated.
 */

export interface PublishTarget {
  folder: string;
  fileName: string;
}

export interface WriteResult {
  /** False when the destination already held exactly this calendar. */
  wrote: boolean;
}

export interface PublishResult {
  path?: string;
  error?: string;
}

export class CalendarWriter {
  /** Content signature of what each vault path was last written with. */
  private readonly lastWritten = new Map<string, string>();
  /** Likewise for the copy outside the vault, keyed by destination as well as file. */
  private readonly lastPublished = new Map<string, { signature: string; path: string }>();

  constructor(
    private readonly vault: FileStore,
    private readonly external: ExternalStore,
    private readonly lifecycle: Lifecycle,
    /**
     * Paths this plugin created. Persisted by the caller, because a reinstall loses the record
     * and the file is still ours — see `assertSafeTarget`.
     */
    private readonly ownedPaths: { has(path: string): boolean; add(path: string): void }
  ) {}

  /** Everything is dropped when the instance is gone; nothing is remembered across a reload. */
  forget(): void {
    this.lastWritten.clear();
    this.lastPublished.clear();
  }

  async writeToVault(path: string, ics: string, signature: string): Promise<WriteResult> {
    if (!this.lifecycle.alive()) return { wrote: false };
    const target = this.vault.normalize(path);
    await this.assertSafeTarget(target);

    // "Still there" means still holding this calendar, not merely still existing. A file a sync
    // client rewrote, another device exported over, or someone edited by hand is not current,
    // and skipping the write left the calendar view saying "out of date" with no way to fix it.
    if (await this.isCurrent(this.lastWritten.get(target), signature, () => this.holds(target, signature))) {
      return { wrote: false };
    }

    await this.ensureParentFolder(target);
    await this.vault.write(target, ics);
    this.lastWritten.set(target, signature);
    if (!this.ownedPaths.has(target)) this.ownedPaths.add(target);
    return { wrote: true };
  }

  async publish(target: PublishTarget, ics: string, signature: string): Promise<string> {
    if (!target.folder.trim()) throw new Error("Publishing is on but no publish folder is set.");
    if (!this.external.available()) throw new Error("Publishing outside the vault only works on desktop.");

    // Keyed on the destination as well as the file, so changing the publish folder republishes
    // rather than being mistaken for "already up to date".
    const key = `${target.folder.trim()} :: ${target.fileName}`;
    const known = this.lastPublished.get(key);
    if (known && (await this.isCurrent(known.signature, signature, () => this.external.exists(known.path)))) {
      return known.path;
    }

    const written = await this.external.write(target.folder, target.fileName, ics);
    this.lastPublished.set(key, { signature, path: written });
    return written;
  }

  /**
   * The rule, once: the content is unchanged *and* the destination still holds it.
   *
   * Two exports of unchanged tasks differ only in DTSTAMP, so rewriting is pure churn — a vault
   * write, an mtime every sync client uploads, and a fresh download for everyone subscribed.
   * But "unchanged" alone is a memory of the past, not a fact about the present.
   */
  private async isCurrent(known: string | undefined, signature: string, stillThere: () => Promise<boolean>): Promise<boolean> {
    if (known !== signature) return false;
    return stillThere();
  }

  private async holds(target: string, signature: string): Promise<boolean> {
    try {
      if (!(await this.vault.exists(target))) return false;
      return matchesSignature(await this.vault.read(target), signature);
    } catch {
      // Cannot tell, so write: a redundant write costs nothing, a skipped one leaves it stale.
      return false;
    }
  }

  /** Refuse to overwrite a file this plugin did not create. */
  private async assertSafeTarget(path: string): Promise<void> {
    if (this.ownedPaths.has(path)) return;
    if (!(await this.vault.exists(path))) return;

    // Ownership records live in data.json; a reinstall loses them. A file that is already one of
    // our calendars is still ours, so read before refusing.
    try {
      const existing = await this.vault.read(path);
      if (existing.startsWith("BEGIN:VCALENDAR") && existing.includes("Task Calendar Bridge")) return;
    } catch {
      // Unreadable means we cannot prove it is ours, so fall through and refuse.
    }

    throw new Error(`${path} already exists and was not created by this plugin. Choose another output path.`);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    if (parts.length === 0) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.vault.exists(current))) await this.vault.mkdir(current);
    }
  }
}

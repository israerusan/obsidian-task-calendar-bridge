import { App, ItemView, Keymap, Menu, Modal, Notice, moment, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { addDays, localToday, monthGrid, shiftMonth, type GridDay } from "../core";
import { entriesByDay, type CalendarPreview, type DayEntry, type PreviewItem } from "../app";
import type { LastExport, TaskCalendarBridgeSettings } from "../settings/schema";

export const CALENDAR_VIEW_TYPE = "task-calendar-bridge-calendar";

/** Days the "Upcoming" agenda covers when no day is selected. */
const AGENDA_DAYS = 14;
/** Dots drawn in one day cell before the rest collapse into a count. */
const MAX_DOTS = 3;

/**
 * Whether the calendar file on disk already holds what the next export would write.
 * "unreadable" is its own state: a file that exists but could not be read is not "missing",
 * and telling someone it was never exported sends them looking for the wrong problem.
 */
export type FileState = "missing" | "current" | "stale" | "unreadable";

export interface PreviewSnapshot {
  preview: CalendarPreview;
  file: FileState;
  /** Why the file could not be read, when it could not. */
  fileError?: string;
  path: string;
  today: string;
  /** An export is running or about to. */
  busy: boolean;
  lastExport: LastExport | null;
}

/** What the view needs from the plugin, and nothing else. */
export interface CalendarViewHost {
  settings: TaskCalendarBridgeSettings;
  previewSnapshot(): Promise<PreviewSnapshot>;
  exportVaultTasks(showNotice: boolean): Promise<void>;
  exportActiveNote(): Promise<void>;
  showLastReport(): void;
  /** The report for the tasks as they are now, rather than as last exported. */
  showPreviewReport(): void;
  openImportGuide(): void;
  createSampleTaskNote(): Promise<void>;
  openSettings(): void;
  saveSettings(): Promise<void>;
  openTask(item: PreviewItem, newLeaf: boolean | "tab" | "split" | "window"): Promise<void>;
  explainTask(item: PreviewItem): void;
  purchaseUrl: string;
}

/**
 * The calendar the export will write, drawn inside the vault.
 *
 * A file-based bridge has one question it could never answer from inside Obsidian: "what is my
 * calendar app about to show me?" This view answers it from the same pipeline the export uses,
 * and says whether the file on disk is current — so a stale calendar is visible here before it
 * is noticed in the calendar app.
 *
 * Read-only on purpose. Every click goes to the task's line, where the task is edited the way
 * it always has been; the view never writes to a note.
 */
export class TaskCalendarView extends ItemView {
  private snapshot: PreviewSnapshot | null = null;
  private error: string | null = null;
  private month: { year: number; month: number };
  /** A chosen day narrows the agenda to that day; null shows the upcoming fortnight. */
  private selected: string | null = null;
  /** The grid cell that holds the roving tab stop. */
  private focusDate: string;
  private refreshTimer: number | null = null;
  /** Bumped per refresh, so a slow one cannot overwrite a newer one's result. */
  private generation = 0;
  private gridEl: HTMLElement | null = null;
  /** A refresh was skipped while the view was hidden. */
  private stale = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CalendarViewHost
  ) {
    super(leaf);
    const now = new Date();
    this.month = { year: now.getFullYear(), month: now.getMonth() + 1 };
    this.focusDate = localToday(now);
  }

  getViewType(): string {
    return CALENDAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Task calendar";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("tcb-view");
    // Expanding a collapsed sidebar or switching to this tab changes the layout; that is when
    // a view that skipped refreshes while hidden catches up.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.stale && this.contentEl.isShown()) {
          this.stale = false;
          this.scheduleRefresh(0);
        }
      })
    );
    this.render();
    await this.refresh();
  }

  onResize(): void {
    if (this.stale && this.contentEl.isShown()) {
      this.stale = false;
      this.scheduleRefresh(0);
    }
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.generation++;
    this.contentEl.empty();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    this.addActions(menu);
  }

  /**
   * Coalesces bursts — an editing session fires a vault event per keystroke pause.
   *
   * A view nobody can see (a collapsed sidebar, a background tab) only remembers that it is
   * stale, and catches up when it is shown: a refresh walks the vault and builds the whole
   * calendar, which is not worth doing every few seconds for a panel that is closed.
   */
  scheduleRefresh(delayMs = 600): void {
    if (!this.contentEl.isShown()) {
      this.stale = true;
      return;
    }
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      // Hidden during the wait counts too: the sidebar can collapse inside the debounce.
      if (!this.contentEl.isShown()) {
        this.stale = true;
        return;
      }
      void this.refresh();
    }, delayMs);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const snapshot = await this.host.previewSnapshot();
      if (generation !== this.generation) return;
      // "Today" moves at midnight; a view left open overnight follows it rather than leaving
      // the highlight and the agenda on yesterday.
      if (this.snapshot && this.snapshot.today !== snapshot.today && this.focusDate === this.snapshot.today) {
        this.focusDate = snapshot.today;
      }
      this.snapshot = snapshot;
      this.error = null;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  // --- Rendering -------------------------------------------------------------

  private render(): void {
    const hadGridFocus = this.gridEl?.contains(this.containerEl.doc.activeElement) ?? false;
    // A background refresh redraws everything; it must not throw away where the reader was.
    const active = this.containerEl.doc.activeElement;
    // instanceOf, not instanceof: in a popped-out window the element belongs to that window's
    // realm, and a bare instanceof against this one is always false there.
    const focusKey = active && active.instanceOf(HTMLElement) && this.contentEl.contains(active) ? active.dataset.focusKey : undefined;
    const scrollTop = this.contentEl.scrollTop;
    const { contentEl } = this;
    contentEl.empty();
    this.drawContent(hadGridFocus);
    contentEl.scrollTop = scrollTop;
    if (focusKey) {
      // Matched by value rather than by a selector, so no key ever needs escaping.
      contentEl.findAll("[data-focus-key]").find((el) => el.dataset.focusKey === focusKey)?.focus();
    }
  }

  private drawContent(hadGridFocus: boolean): void {
    const { contentEl } = this;

    this.renderStatus(contentEl);
    const snapshot = this.snapshot;
    if (!snapshot) {
      contentEl.createDiv({ cls: "tcb-muted tcb-pad", text: this.error ? `Could not read your tasks: ${this.error}` : "Reading your tasks…" });
      return;
    }

    if (snapshot.preview.items.length === 0) {
      this.renderEmpty(contentEl);
      return;
    }

    this.renderNotes(contentEl, snapshot);
    this.renderMonth(contentEl, snapshot);
    this.renderAgenda(contentEl, snapshot);
    this.renderFooter(contentEl);

    // A refresh while someone is arrowing through the grid must not throw their focus away.
    if (hadGridFocus) this.focusCell(this.focusDate);
  }

  private renderStatus(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "tcb-statusbar" });
    // A button, not a label: every state but "up to date" has one obvious next step, and the
    // pill is where the eye already is.
    const pill = bar.createEl("button", { cls: "tcb-pill" });
    pill.dataset.focusKey = "pill";
    const dot = pill.createSpan({ cls: "tcb-pill-dot" });
    const label = pill.createSpan({ cls: "tcb-pill-label" });

    const actions = bar.createDiv({ cls: "tcb-actions" });
    this.iconButton(actions, "refresh-cw", "Export the vault calendar now", () => void this.host.exportVaultTasks(true));
    this.iconButton(actions, "more-horizontal", "More actions", (event) => {
      const menu = new Menu();
      this.addActions(menu);
      menu.showAtMouseEvent(event);
    });

    const snapshot = this.snapshot;
    if (!snapshot) {
      pill.addClass("is-idle");
      label.setText(this.error ? "Unavailable" : "Loading");
      return;
    }

    const failed = snapshot.lastExport?.error && snapshot.lastExport.path === snapshot.path ? snapshot.lastExport.error : null;
    const exportNow = (): void => void this.host.exportVaultTasks(true);
    const report = (): void => this.host.showPreviewReport();
    let state: { cls: string; text: string; detail: string; action: () => void };
    if (snapshot.busy) {
      state = { cls: "is-busy", text: "Updating…", detail: "An export is running or about to.", action: report };
    } else if (failed) {
      state = { cls: "is-error", text: "Export failed", detail: `${failed} Click to try again.`, action: exportNow };
    } else if (snapshot.lastExport?.publishError && snapshot.lastExport.path === snapshot.path && this.host.settings.publishEnabled) {
      // The file in the vault can be perfect while the published copy — the one people actually
      // subscribe to — has stopped updating. Green would be a lie.
      state = {
        cls: "is-error",
        text: "Publishing failed",
        detail: `The vault file is written, but the published copy is not: ${snapshot.lastExport.publishError} Click to try again.`,
        action: exportNow,
      };
    } else if (snapshot.file === "unreadable") {
      state = {
        cls: "is-error",
        text: "Cannot read the file",
        detail: `${snapshot.path} exists but could not be read${snapshot.fileError ? ` (${snapshot.fileError})` : ""}. A sync client may be holding it. Click to export again.`,
        action: exportNow,
      };
    } else if (snapshot.file === "missing") {
      state = { cls: "is-stale", text: "Not exported yet", detail: `${snapshot.path} does not exist yet. Click to export it.`, action: exportNow };
    } else if (snapshot.file === "stale") {
      const auto = this.host.settings.isPro && this.host.settings.autoExport;
      state = {
        cls: "is-stale",
        text: "Out of date",
        detail: auto
          ? `${snapshot.path} differs from your tasks; auto-export will update it after your next edit. Click to export now.`
          : `${snapshot.path} differs from your tasks. Click to export now.`,
        action: exportNow,
      };
    } else {
      state = { cls: "is-current", text: "Up to date", detail: `${snapshot.path} matches your tasks. Click for the full breakdown.`, action: report };
    }

    pill.addClass(state.cls);
    dot.setAttr("aria-hidden", "true");
    const events = snapshot.preview.eventCount;
    label.setText(`${state.text} · ${events} event${events === 1 ? "" : "s"}`);
    // setTooltip writes aria-label too, so the spoken name is the state and what a click does.
    setTooltip(pill, `${state.text}. ${state.detail}`);
    pill.addEventListener("click", state.action);
  }

  private renderEmpty(container: HTMLElement): void {
    const card = container.createDiv({ cls: "tcb-empty" });
    card.createEl("h4", { text: "No dated tasks yet" });
    card.createEl("p", { text: "Give a task a date and it appears here, and in the calendar file your calendar app reads:" });
    card.createEl("code", { text: "- [ ] Call Sam 📅 2026-10-20" });
    const steps = card.createEl("ol");
    steps.createEl("li", { text: "Write or create a note with a dated task." });
    steps.createEl("li", { text: "Export, or let auto-export do it (Pro)." });
    steps.createEl("li", { text: "Import or subscribe in your calendar app." });

    const buttons = card.createDiv({ cls: "tcb-empty-buttons" });
    const sample = buttons.createEl("button", { text: "Create a sample note", cls: "mod-cta" });
    sample.addEventListener("click", () => void this.host.createSampleTaskNote());
    const guide = buttons.createEl("button", { text: "Open the setup guide" });
    guide.addEventListener("click", () => this.host.openImportGuide());
  }

  /** The one or two things worth knowing before reading the calendar. */
  private renderNotes(container: HTMLElement, snapshot: PreviewSnapshot): void {
    const { preview } = snapshot;
    if (preview.capped > 0) {
      const note = container.createDiv({ cls: "tcb-note" });
      // The cap counts tasks, not events: a duplicate inside the selection still takes a free
      // slot, and is reported separately below as a task that cannot be exported.
      const selected = preview.items.filter((item) => item.state !== "capped").length;
      note.createSpan({
        text: `The free tier exports the next ${selected} of your ${preview.totalFound} dated tasks.${this.host.settings.previewShowCapped ? " The rest are shown faded." : ""} `,
      });
      const link = note.createEl("a", { text: "Get Pro", href: this.host.purchaseUrl });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
    const lost = preview.counts.lost + preview.duplicates;
    if (lost > 0) {
      const note = container.createDiv({ cls: "tcb-note is-warning" });
      note.createSpan({ text: `${lost} task${lost === 1 ? "" : "s"} cannot be exported. ` });
      const link = note.createEl("a", { text: "See why", href: "#" });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        // The tasks as they are now — the last export's report may describe an older state.
        this.host.showPreviewReport();
      });
    }
  }

  private renderMonth(container: HTMLElement, snapshot: PreviewSnapshot): void {
    const settings = this.host.settings;
    const weekStart = settings.weekStart === "monday" ? 1 : settings.weekStart === "sunday" ? 0 : moment.localeData().firstDayOfWeek();
    const weeks = monthGrid(this.month.year, this.month.month, weekStart, snapshot.today);
    const first = weeks[0].days[0].date;
    const last = weeks[weeks.length - 1].days[6].date;
    const byDay = entriesByDay(this.visibleItems(snapshot), first, last);

    const nav = container.createDiv({ cls: "tcb-nav" });
    const title = moment({ year: this.month.year, month: this.month.month - 1, day: 1 }).format("MMMM YYYY");
    nav.createDiv({ cls: "tcb-nav-title", text: title });
    const navButtons = nav.createDiv({ cls: "tcb-nav-buttons" });
    this.iconButton(navButtons, "chevron-left", "Previous month", () => this.moveMonth(-1));
    const todayButton = navButtons.createEl("button", { text: "Today", cls: "tcb-today-button" });
    todayButton.dataset.focusKey = "today";
    todayButton.addEventListener("click", () => this.goToday());
    this.iconButton(navButtons, "chevron-right", "Next month", () => this.moveMonth(1));
    this.iconButton(navButtons, "help-circle", "Calendar legend and keys", () => this.showLegend());

    // The tab stop must sit on a day the grid actually draws.
    if (!weeks.some((week) => week.days.some((day) => day.date === this.focusDate))) {
      const inMonth = weeks.flatMap((week) => week.days).filter((day) => day.inMonth);
      this.focusDate = (inMonth.find((day) => day.isToday) ?? inMonth[0]).date;
    }

    const grid = container.createDiv({ cls: "tcb-grid" });
    this.gridEl = grid;
    grid.setAttr("role", "grid");
    grid.setAttr("aria-label", title);
    if (settings.showWeekNumbers) grid.addClass("has-week-numbers");

    const head = grid.createDiv({ cls: "tcb-grid-row tcb-grid-head" });
    head.setAttr("role", "row");
    if (settings.showWeekNumbers) head.createDiv({ cls: "tcb-weeknum", text: "Wk" }).setAttr("role", "columnheader");
    const names = moment.weekdaysMin();
    for (let i = 0; i < 7; i++) {
      const cell = head.createDiv({ cls: "tcb-weekday", text: names[(weekStart + i) % 7] });
      cell.setAttr("role", "columnheader");
    }

    for (const week of weeks) {
      const row = grid.createDiv({ cls: "tcb-grid-row" });
      row.setAttr("role", "row");
      if (settings.showWeekNumbers) {
        const num = row.createDiv({ cls: "tcb-weeknum", text: String(week.isoWeek) });
        num.setAttr("role", "rowheader");
        num.setAttr("aria-label", `Week ${week.isoWeek}`);
      }
      for (const day of week.days) this.renderDay(row, day, byDay.get(day.date) ?? []);
    }

    grid.addEventListener("keydown", (event) => this.onGridKey(event));
  }

  private renderDay(row: HTMLElement, day: GridDay, entries: DayEntry[]): void {
    const cell = row.createDiv({ cls: "tcb-day" });
    cell.setAttr("role", "gridcell");
    cell.dataset.date = day.date;
    cell.tabIndex = day.date === this.focusDate ? 0 : -1;
    if (!day.inMonth) cell.addClass("is-outside");
    if (day.isToday) cell.addClass("is-today");
    if (day.weekday === 0 || day.weekday === 6) cell.addClass("is-weekend");
    if (day.date === this.selected) {
      cell.addClass("is-selected");
      cell.setAttr("aria-selected", "true");
    }

    cell.createDiv({ cls: "tcb-day-number", text: String(Number(day.date.slice(8))) });
    const dots = cell.createDiv({ cls: "tcb-dots" });
    dots.setAttr("aria-hidden", "true");
    for (const entry of entries.slice(0, MAX_DOTS)) {
      dots.createSpan({ cls: `tcb-dot is-${entry.item.state}${entry.kind === "continues" ? " is-continuation" : ""}` });
    }
    if (entries.length > MAX_DOTS) dots.createSpan({ cls: "tcb-more", text: `+${entries.length - MAX_DOTS}` });

    const inFile = entries.filter((entry) => entry.item.state === "exported").length;
    const spoken = moment(day.date, "YYYY-MM-DD").format("dddd D MMMM YYYY");
    const count = entries.length === 0 ? "no events" : `${inFile} event${inFile === 1 ? "" : "s"}${inFile < entries.length ? `, ${entries.length - inFile} not in the file` : ""}`;
    const label = `${spoken}${day.isToday ? ", today" : ""}, ${count}`;
    if (entries.length === 0) {
      cell.setAttr("aria-label", label);
    } else {
      // One string for both: setTooltip writes aria-label itself, so a separate label set
      // before it was silently replaced and a screen reader heard titles with no date.
      const lines = entries.slice(0, 8).map((entry) => `${entryTime(entry)}  ${entry.item.task.title}`);
      if (entries.length > 8) lines.push(`…and ${entries.length - 8} more`);
      setTooltip(cell, [label, ...lines].join("\n"), { placement: "bottom" });
    }

    cell.addEventListener("click", () => this.selectDay(day.date));
  }

  private renderAgenda(container: HTMLElement, snapshot: PreviewSnapshot): void {
    const agenda = container.createDiv({ cls: "tcb-agenda" });
    const header = agenda.createDiv({ cls: "tcb-agenda-header" });
    // Three scopes, in order: the chosen day; the upcoming fortnight while today's month is on
    // screen; otherwise the whole month on screen, so paging the grid also pages the list.
    const monthStart = `${this.month.year}-${String(this.month.month).padStart(2, "0")}-01`;
    const showingToday = snapshot.today.startsWith(monthStart.slice(0, 8));
    const scope: "day" | "upcoming" | "month" = this.selected ? "day" : showingToday ? "upcoming" : "month";
    const from = scope === "day" && this.selected ? this.selected : scope === "upcoming" ? snapshot.today : monthStart;
    const to =
      scope === "day" && this.selected
        ? this.selected
        : scope === "upcoming"
          ? addDays(snapshot.today, AGENDA_DAYS - 1)
          : addDays(shiftMonthStart(this.month.year, this.month.month, 1), -1);
    header.createDiv({
      cls: "tcb-agenda-title",
      text:
        scope === "day" && this.selected
          ? moment(this.selected, "YYYY-MM-DD").format("dddd D MMMM")
          : scope === "upcoming"
            ? "Upcoming"
            : moment(monthStart, "YYYY-MM-DD").format("MMMM YYYY"),
    });
    if (scope !== "upcoming") {
      const clear = header.createEl("a", { text: "Show upcoming", href: "#", cls: "tcb-link" });
      clear.addEventListener("click", (event) => {
        event.preventDefault();
        this.goToday();
      });
    }

    const byDay = entriesByDay(this.visibleItems(snapshot), from, to);
    const days = [...byDay.keys()].sort();
    if (days.length === 0) {
      agenda.createDiv({
        cls: "tcb-muted",
        text: scope === "day" ? "Nothing on this day." : scope === "upcoming" ? `Nothing in the next ${AGENDA_DAYS} days.` : "Nothing this month.",
      });
      return;
    }

    for (const date of days) {
      const group = agenda.createDiv({ cls: "tcb-agenda-day" });
      if (scope !== "day") {
        const label = date === snapshot.today ? "Today" : date === addDays(snapshot.today, 1) ? "Tomorrow" : moment(date, "YYYY-MM-DD").format("ddd D MMM");
        group.createDiv({ cls: "tcb-agenda-date", text: label });
      }
      const list = group.createEl("ul", { cls: "tcb-entries" });
      for (const entry of byDay.get(date) ?? []) this.renderEntry(list, entry);
    }
  }

  private renderEntry(list: HTMLElement, entry: DayEntry): void {
    const { item } = entry;
    const { task } = item;
    const row = list.createEl("li", { cls: `tcb-entry is-${item.state}` });
    // A real button inside the list item, so the list keeps its list semantics and the row gets
    // native focus, Enter and Space, rather than a <li> pretending to be a button.
    const open = row.createEl("button", { cls: "tcb-entry-open" });
    open.dataset.focusKey = `open:${item.uid}:${entry.date}:${task.line}`;

    open.createSpan({ cls: "tcb-entry-time", text: entryTime(entry) });
    const body = open.createSpan({ cls: "tcb-entry-body" });
    const title = body.createSpan({ cls: "tcb-entry-title" });
    if (task.status === "done") title.addClass("is-done");
    if (task.status === "cancelled") title.addClass("is-cancelled");
    title.setText(task.title);

    const meta = body.createSpan({ cls: "tcb-entry-meta" });
    if (task.recurrence) this.badge(meta, "repeat", `Repeats ${task.recurrence.source}`);
    if (task.reminderMinutes) this.badge(meta, "bell", "Has a reminder alarm");
    if (task.priority !== undefined && task.priority <= 2) this.badge(meta, "arrow-up", "High priority");
    if (item.state === "capped") this.badge(meta, "lock", "Not in the file — past the free tier's limit");
    if (item.state === "duplicate") this.badge(meta, "alert-triangle", "Not in the file — shares an identity with another task");
    for (const tag of task.tags.slice(0, 3)) meta.createSpan({ cls: "tcb-tag", text: `#${tag}` });
    // The note's name, not its folder path: a narrow sidebar has no room for it, and the full
    // path is one hover away.
    const note = noteName(task.sourcePath);
    const source = meta.createSpan({ cls: "tcb-source", text: note });
    source.setAttr("title", `${task.sourcePath}, line ${task.line}`);

    const states: Record<PreviewItem["state"], string> = {
      exported: "",
      capped: ", not in the calendar file",
      duplicate: ", not in the calendar file because of a duplicate identity",
    };
    open.setAttr("aria-label", `${entryTime(entry)}, ${task.title}${states[item.state]}, in ${note}`);

    const more = row.createEl("button", { cls: "clickable-icon tcb-entry-more" });
    more.dataset.focusKey = `more:${item.uid}:${entry.date}:${task.line}`;
    setIcon(more, "more-vertical");
    more.setAttr("aria-label", `More actions for ${task.title}`);
    setTooltip(more, "More actions");

    const showMenu = (position: { x: number; y: number }): void => {
      const menu = new Menu();
      menu.addItem((menuItem) => menuItem.setTitle("Open note").setIcon("file").onClick(() => void this.host.openTask(item, false)));
      menu.addItem((menuItem) => menuItem.setTitle("Open in new tab").setIcon("file-plus").onClick(() => void this.host.openTask(item, "tab")));
      menu.addItem((menuItem) => menuItem.setTitle("Open to the right").setIcon("separator-vertical").onClick(() => void this.host.openTask(item, "split")));
      menu.addSeparator();
      menu.addItem((menuItem) => menuItem.setTitle("Explain calendar event").setIcon("info").onClick(() => this.host.explainTask(item)));
      menu.addItem((menuItem) => menuItem.setTitle("Copy event UID").setIcon("copy").onClick(() => void this.copyUid(item.uid)));
      menu.showAtPosition(position, this.containerEl.doc);
    };
    const below = (el: HTMLElement): { x: number; y: number } => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom };
    };

    open.addEventListener("click", (event) => void this.host.openTask(item, Keymap.isModEvent(event)));
    open.addEventListener("auxclick", (event) => {
      if (event.button === 1) void this.host.openTask(item, "tab");
    });
    open.addEventListener("keydown", (event) => {
      // The keyboard's own way to the context menu, so nothing is right-click-only.
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        showMenu(below(open));
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // A keyboard-raised contextmenu event has no pointer position worth using.
      showMenu(event.clientX === 0 && event.clientY === 0 ? below(open) : { x: event.clientX, y: event.clientY });
    });
    more.addEventListener("click", () => showMenu(below(more)));
  }

  private async copyUid(uid: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uid);
      new Notice("Event UID copied.");
    } catch {
      new Notice(`Could not reach the clipboard. The UID is ${uid}`, 10000);
    }
  }

  private renderFooter(container: HTMLElement): void {
    const footer = container.createDiv({ cls: "tcb-footer" });
    const link = footer.createEl("a", { text: "How to put this calendar in your calendar app", href: "#" });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.host.openImportGuide();
    });
  }

  // --- Behaviour -------------------------------------------------------------

  private visibleItems(snapshot: PreviewSnapshot): PreviewItem[] {
    if (this.host.settings.previewShowCapped) return snapshot.preview.items;
    return snapshot.preview.items.filter((item) => item.state !== "capped");
  }

  private addActions(menu: Menu): void {
    menu.addItem((item) => item.setTitle("Export the vault calendar").setIcon("refresh-cw").onClick(() => void this.host.exportVaultTasks(true)));
    menu.addItem((item) => item.setTitle("Export the current note").setIcon("file-output").onClick(() => void this.host.exportActiveNote()));
    menu.addItem((item) => item.setTitle("Show last export report").setIcon("list-checks").onClick(() => this.host.showLastReport()));
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Show tasks past the free limit")
        .setIcon("eye")
        .setChecked(this.host.settings.previewShowCapped)
        .onClick(() => {
          this.host.settings.previewShowCapped = !this.host.settings.previewShowCapped;
          void this.host.saveSettings();
          this.render();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Show week numbers")
        .setIcon("hash")
        .setChecked(this.host.settings.showWeekNumbers)
        .onClick(() => {
          this.host.settings.showWeekNumbers = !this.host.settings.showWeekNumbers;
          void this.host.saveSettings();
          this.render();
        })
    );
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Calendar setup guide").setIcon("help-circle").onClick(() => this.host.openImportGuide()));
    menu.addItem((item) => item.setTitle("Settings").setIcon("settings").onClick(() => this.host.openSettings()));
  }

  private selectDay(date: string | null): void {
    this.selected = date === this.selected ? null : date;
    if (date) {
      this.focusDate = date;
      // Clicking a borrowed day from a neighbouring month moves the grid to that month.
      const [year, month] = date.split("-").map(Number);
      if (year !== this.month.year || month !== this.month.month) this.month = { year, month };
    }
    this.render();
    if (date) this.focusCell(date);
  }

  private moveMonth(delta: number): void {
    this.month = shiftMonth(this.month.year, this.month.month, delta);
    this.dropSelectionOutsideMonth();
    this.render();
  }

  /** The agenda follows the grid: a chosen day in a month no longer on screen is let go. */
  private dropSelectionOutsideMonth(): void {
    const prefix = `${this.month.year}-${String(this.month.month).padStart(2, "0")}-`;
    if (this.selected && !this.selected.startsWith(prefix)) this.selected = null;
  }

  private goToday(): void {
    const today = this.snapshot?.today ?? localToday();
    const [year, month] = today.split("-").map(Number);
    this.month = { year, month };
    this.focusDate = today;
    this.selected = null;
    this.render();
    this.focusCell(today);
  }

  /**
   * Arrow keys move a day or a week, Page Up/Down a month, Home goes to today; Enter or Space
   * shows the day's agenda and Escape clears it. One tab stop for the whole grid, so the grid
   * is a single step in the sidebar's tab order rather than forty-two.
   */
  private onGridKey(event: KeyboardEvent): void {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let target: string | null = null;
    if (event.key in steps) target = addDays(this.focusDate, steps[event.key]);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      const [year, month, day] = this.focusDate.split("-").map(Number);
      const next = shiftMonth(year, month, event.key === "PageUp" ? -1 : 1);
      const lastDay = new Date(Date.UTC(next.year, next.month, 0)).getUTCDate();
      target = `${next.year}-${String(next.month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
    } else if (event.key === "Home") target = this.snapshot?.today ?? localToday();
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.selectDay(this.focusDate);
      return;
    } else if (event.key === "Escape" && this.selected) {
      event.preventDefault();
      this.selectDay(null);
      return;
    }
    if (!target) return;

    event.preventDefault();
    this.focusDate = target;
    const [year, month] = target.split("-").map(Number);
    if (year !== this.month.year || month !== this.month.month) {
      this.month = { year, month };
      this.dropSelectionOutsideMonth();
      this.render();
    } else {
      this.gridEl?.querySelectorAll<HTMLElement>(".tcb-day").forEach((cell) => {
        cell.tabIndex = cell.dataset.date === target ? 0 : -1;
      });
    }
    this.focusCell(target);
  }

  private focusCell(date: string): void {
    const cell = this.gridEl?.querySelector<HTMLElement>(`.tcb-day[data-date="${date}"]`);
    cell?.focus();
  }

  private showLegend(): void {
    new LegendModal(this.app).open();
  }

  private iconButton(container: HTMLElement, icon: string, label: string, onClick: (event: MouseEvent) => void): HTMLElement {
    const button = container.createEl("button", { cls: "clickable-icon tcb-icon-button" });
    button.dataset.focusKey = `icon:${icon}`;
    setIcon(button, icon);
    button.setAttr("aria-label", label);
    setTooltip(button, label);
    button.addEventListener("click", onClick);
    return button;
  }

  private badge(container: HTMLElement, icon: string, label: string): void {
    const badge = container.createSpan({ cls: "tcb-badge-icon" });
    setIcon(badge, icon);
    badge.setAttr("aria-label", label);
    setTooltip(badge, label);
  }
}

/** `Projects/Launch plan.md` → `Launch plan`. */
function noteName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** The first day of the month `delta` months from the given one, as `YYYY-MM-DD`. */
function shiftMonthStart(year: number, month: number, delta: number): string {
  const next = shiftMonth(year, month, delta);
  return `${next.year}-${String(next.month).padStart(2, "0")}-01`;
}

function entryTime(entry: DayEntry): string {
  if (entry.kind === "continues") return "Cont.";
  return entry.item.task.startTime ?? "All day";
}

/** What the dots mean and which keys work — the view has no room to say it inline. */
class LegendModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Task calendar");
    const { contentEl } = this;
    contentEl.addClass("tcb-legend");

    contentEl.createEl("h4", { text: "What the marks mean" });
    const marks = contentEl.createEl("ul");
    const mark = (cls: string, text: string): void => {
      const row = marks.createEl("li");
      row.createSpan({ cls: `tcb-dot ${cls}` }).setAttr("aria-hidden", "true");
      row.createSpan({ text });
    };
    mark("is-exported", "An event in your calendar file.");
    mark("is-capped", "A dated task that is not in the file — past the free tier's limit.");
    mark("is-duplicate", "A task left out because another task has the same identity.");
    mark("is-exported is-continuation", "A multi-day event, continuing.");
    contentEl.createEl("p", { text: "Repeating events appear on every day they occur, the way your calendar app will show them." });

    contentEl.createEl("h4", { text: "Keys in the month grid" });
    const keys = contentEl.createEl("ul");
    for (const text of [
      "Arrow keys move by day; up and down move by week.",
      "Page up and Page down change month. Home goes to today.",
      "Enter or Space shows that day's tasks. Escape goes back to upcoming.",
    ]) {
      keys.createEl("li", { text });
    }

    contentEl.createEl("h4", { text: "Tasks in the list" });
    const tasks = contentEl.createEl("ul");
    for (const text of [
      "Click a task to open its line. Ctrl- or Cmd-click opens a new tab; middle-click does too.",
      "Right-click for more: open to the right, explain the event, copy its UID.",
    ]) {
      tasks.createEl("li", { text });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

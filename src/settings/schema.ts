import type { DuplicateIdentity, SkipCounts, SkippedTask, TimeMode } from "../core";
import { DEFAULT_CURRENT_NOTE_OUTPUT_PATH, DEFAULT_VAULT_OUTPUT_PATH } from "../core";

/**
 * What the plugin persists, and what the settings tab needs from the plugin.
 *
 * Separate from the tab that renders it because three modules need this schema and only one of
 * them draws anything. While it lived in the tab file, `main.ts` imported the tab to get
 * `DEFAULT_SETTINGS`, the tab imported `main.ts` back for its type, and the whole arrangement
 * survived only because that last edge happened to be `import type` and `isolatedModules`
 * erases it. One value import across it would have made a real runtime cycle.
 *
 * This file imports nothing from `obsidian`, so a test can read the schema directly.
 */

export interface LastExport {
  at: string;
  scope: string;
  path: string;
  eventCount: number;
  /** Genuine losses only — see SkipCounts. */
  skippedCount: number;
  counts?: SkipCounts;
  error?: string;
  publishError?: string;
  /** Kept so the report survives a restart, when it is needed most. */
  skipped?: SkippedTask[];
  /** Likewise: an id collision is invisible until someone reads the report. */
  duplicateIds?: DuplicateIdentity[];
  totalFound?: number;
  capped?: number;
}

/**
 * A constant, not a setting.
 *
 * It used to be persisted, and `Object.assign({}, DEFAULT_SETTINGS, loaded)` always lets the
 * stored value win — so every install froze the checkout link at whatever release first wrote
 * data.json, and moving the product page would have left every existing user with a "Get Pro"
 * button pointing at a dead page.
 */
export const PURCHASE_URL = "https://buymeacoffee.com/vaultspotlight/e/560210";

export interface TaskCalendarBridgeSettings {
  licenseKey: string;
  isPro: boolean;
  licenseEmail: string;
  calendarName: string;
  vaultOutputPath: string;
  currentNoteOutputPath: string;
  defaultDurationMinutes: number;
  timeMode: TimeMode;
  timeZone: string;
  allDayReminderTime: string;
  exportTags: boolean;
  linkToSource: boolean;
  autoExport: boolean;
  includeCompleted: boolean;
  includeReminders: boolean;
  includeRecurrence: boolean;
  includeFolders: string;
  excludeFolders: string;
  publishEnabled: boolean;
  publishPath: string;
  lastExport: LastExport | null;
  /** Paths this plugin created, so it never overwrites a file it does not own. */
  ownedPaths: string[];
  hasOnboarded: boolean;
  /** Which day the calendar view's weeks start on. `locale` follows Obsidian's language. */
  weekStart: WeekStart;
  showWeekNumbers: boolean;
  /** Whether the calendar view also draws dated tasks the file leaves out (the free cap). */
  previewShowCapped: boolean;
  /** Show the "What's new" notes once after an update. */
  showReleaseNotes: boolean;
  /** The newest release whose notes this vault has been shown. Empty until the first load. */
  lastSeenVersion: string;
}

export type WeekStart = "locale" | "monday" | "sunday";

export const DEFAULT_SETTINGS: TaskCalendarBridgeSettings = {
  licenseKey: "",
  isPro: false,
  licenseEmail: "",
  calendarName: "Obsidian Tasks",
  vaultOutputPath: DEFAULT_VAULT_OUTPUT_PATH,
  currentNoteOutputPath: DEFAULT_CURRENT_NOTE_OUTPUT_PATH,
  defaultDurationMinutes: 30,
  timeMode: "floating",
  timeZone: "",
  allDayReminderTime: "09:00",
  exportTags: true,
  linkToSource: true,
  autoExport: false,
  includeCompleted: false,
  // Sold as "Pro adds repeating events and reminders", so they are on the moment Pro is active.
  // Both are gated by isPro at export time anyway, and shipping them off by default made a paid
  // feature look broken.
  includeReminders: true,
  includeRecurrence: true,
  includeFolders: "",
  excludeFolders: "",
  publishEnabled: false,
  publishPath: "",
  lastExport: null,
  ownedPaths: [],
  hasOnboarded: false,
  weekStart: "locale",
  showWeekNumbers: false,
  previewShowCapped: true,
  showReleaseNotes: true,
  lastSeenVersion: "",
};

/** Pro-gated settings, by the control that edits them. */
export type ProToggleKey = "autoExport" | "includeCompleted" | "includeReminders" | "includeRecurrence" | "publishEnabled";
export type ProTextKey = "includeFolders" | "excludeFolders" | "publishPath";

/**
 * Everything the settings tab needs from the plugin — and nothing else.
 *
 * Typing the tab against this rather than against the plugin class is what lets the schema stop
 * importing `main.ts`. It also states the coupling plainly: ten members, not a whole god object.
 */
export interface PluginHost {
  settings: TaskCalendarBridgeSettings;
  /** Structural, so this file still imports nothing from `obsidian`. */
  manifest: { id: string; version: string };
  /** True when data.json exists but could not be read, so nothing may be saved. */
  settingsUnreadable: boolean;
  dataPath(): string;
  refreshLicense(): Promise<void>;
  saveSettings(): Promise<void>;
  /** Debounced, for values edited by typing. */
  saveSettingsSoon(): void;
  flushSettings(): Promise<void>;
  openImportGuide(): void;
  createSampleTaskNote(): Promise<void>;
  showLastReport(): void;
  openCalendarView(): Promise<void>;
  showWhatsNew(): void;
  copyDiagnostics(): Promise<void>;
  /** Redraws any open calendar view after a setting that changes what it shows. */
  refreshCalendarViews(): void;
}

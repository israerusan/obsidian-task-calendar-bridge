import type { TaskCalendarBridgeSettings } from "../settings/schema";
import { FREE_TASK_LIMIT } from "../core";

/**
 * What this user is allowed to do, in one place.
 *
 * The licence flag was consulted at 22 sites in six different shapes: `isPro && setting` in six
 * places, `isPro` alone in five, one setting deliberately ungated, one *inverted* gate, one
 * three-way condition, and the two operands written in either order depending on the file. Two
 * rival proxies stood in for "is this user free" (`capped > 0` and `isPro`), and the free limit
 * was reached by two different routes.
 *
 * That mattered because `includeReminders` and `includeRecurrence` default to **true**: on a
 * free install the setting is on while the entitlement is off, so every `isPro &&` is
 * load-bearing and a single dropped conjunct silently ships a paid feature.
 *
 * This function NAMES all of those decisions. It deliberately does not change any of them — the
 * asymmetries below are each a fix for a shipped bug, and the point of gathering them here is
 * that the next reader can see them rather than rediscover them.
 */
export interface Entitlements {
  pro: boolean;
  /** Null means no cap. The free tier exports the next N upcoming tasks. */
  taskLimit: number | null;
  autoExport: boolean;
  includeCompleted: boolean;
  includeRecurrence: boolean;
  includeReminders: boolean;
  /**
   * Include lists lapse with the licence. Exclusions do NOT, and there is no flag for them
   * here on purpose: gating exclusions made losing a licence *add* content — every archived
   * task and template placeholder arrived at once. Turning a paid feature off must never
   * widen the output.
   */
  useIncludeFolders: boolean;
  publish: boolean;
  /**
   * Publishing is switched on but no longer running, because the licence lapsed. This is the
   * one inverted gate: `setting && !pro` produces behaviour (a warning) rather than suppressing
   * it, because the copy other people subscribed to is now silently frozen.
   */
  publishIsInert: boolean;
}

export function entitlements(settings: TaskCalendarBridgeSettings): Entitlements {
  const pro = settings.isPro;
  return {
    pro,
    taskLimit: pro ? null : FREE_TASK_LIMIT,
    autoExport: pro && settings.autoExport,
    includeCompleted: pro && settings.includeCompleted,
    includeRecurrence: pro && settings.includeRecurrence,
    includeReminders: pro && settings.includeReminders,
    useIncludeFolders: pro,
    publish: pro && settings.publishEnabled,
    publishIsInert: settings.publishEnabled && !pro,
  };
}

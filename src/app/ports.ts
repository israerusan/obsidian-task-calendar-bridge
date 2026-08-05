/**
 * The Obsidian surface, as plain interfaces.
 *
 * Nothing in this file imports `obsidian`, and neither does anything that depends on it. That is
 * deliberate and load-bearing: the obsidian package ships types only, with no runtime module, so
 * a file that imports it cannot be loaded by a test at any price. Everything below is small
 * enough that a fake is a literal object.
 *
 * `main.ts` supplies the real implementations by closing over `this.app`.
 */

/** Reading and writing inside the vault. */
export interface FileStore {
  /** The vault's own path normalisation — folds invisible spaces, applies NFC. */
  normalize(path: string): string;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Writing the published copy, which lives outside the vault and may not exist at all. */
export interface ExternalStore {
  /** False on mobile, where there is no filesystem to reach. */
  available(): boolean;
  exists(fullPath: string): Promise<boolean>;
  /** Returns the full path written. Throws with a message meant for a Notice. */
  write(folder: string, fileName: string, contents: string): Promise<string>;
}

/**
 * Whether this plugin instance is still the live one.
 *
 * Checked after every await in the write path. An export already in flight when the plugin is
 * disabled reaches the write seconds later, and would otherwise put a calendar into a vault
 * whose plugin instance is gone — clobbering whatever a freshly loaded instance had just saved.
 */
export interface Lifecycle {
  alive(): boolean;
}

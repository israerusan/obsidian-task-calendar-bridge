// The architectural seam, enforced.
//
// `src/core` is pure: it imports nothing from "obsidian" and therefore bundles with plain
// esbuild, which is the only reason tests/core.test.mjs can cover 2,000 lines of it without a
// fake Obsidian module. That property is load-bearing and invisible — nothing stops someone
// adding `import { Notice } from "obsidian"` to a core file, and the moment they do, the test
// suite stops building with an error that points at esbuild rather than at the mistake.
//
// node_modules/obsidian ships types only ("main": "", no .js anywhere), so a violation is not a
// style problem. It is the difference between a layer that can be tested and one that cannot.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Directories that must stay free of Obsidian imports, and what each one buys.
 * Later phases of the de-scarring work add rows here; that is the point of the list.
 */
const PURE_DIRS = [
  { dir: "src/core", reason: "tests/core.test.mjs bundles it directly, with no fake Obsidian module" },
  { dir: "src/app", reason: "tests/app.test.mjs bundles it directly — the export pipeline is only testable while it stays pure" },
];

/**
 * Import edges that must not exist.
 *
 * Every cycle this repo had was broken by a single `import type` edge that isolatedModules
 * erases, so there was never a runtime cycle — but one value import across the same edge would
 * have made one, and nothing said so. These are directed: `from` may not import `to` at all.
 */
const FORBIDDEN_EDGES = [
  {
    from: "src/settings",
    to: "src/main",
    reason: "the settings layer is typed against PluginHost precisely so it does not depend on the plugin class",
  },
  {
    from: "src/core",
    to: "src/settings",
    reason: "core must not depend on how the plugin happens to store its configuration",
  },
];

function sourceFiles(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  const found = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(relative));
    else if (entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

// --- No Obsidian inside the pure layers --------------------------------------

for (const { dir, reason } of PURE_DIRS) {
  const files = sourceFiles(dir);
  assert.ok(files.length > 0, `${dir} has no .ts files — the guard is pointing at the wrong place`);

  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const importsObsidian = /^\s*import\s[^\n]*?from\s+["']obsidian["']/m.test(source) || /\brequire\(\s*["']obsidian["']\s*\)/.test(source);
    assert.ok(!importsObsidian, `${file} imports "obsidian". ${dir} must stay pure — ${reason}.`);
  }
}

// --- No import edge that would create a runtime module cycle ------------------

for (const { from, to, reason } of FORBIDDEN_EDGES) {
  for (const file of sourceFiles(from)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^\n]*?from\s+["']([^"']+)["']/gm)) {
      const [, typeOnly, specifier] = match;
      // A type-only import is erased at emit, so it cannot form a runtime cycle.
      if (typeOnly) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(!resolved.startsWith(to), `${file} has a value import of ${specifier}. ${reason}`);
    }
  }
}

console.log("seam tests passed");

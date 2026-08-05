// Manifest/versions contract — the checks Obsidian's review runs on manifest.json
// that eslint-plugin-obsidianmd's `validate-manifest` can't (eslint doesn't lint the
// JSON file without a JSON language plugin). Locks the exact class of issues we've
// been dinged on (the word "Obsidian" in the description) plus release consistency.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

// --- Redundant words the review rejects -------------------------------------
assert.ok(!/\bobsidian\b/i.test(manifest.description), 'manifest.description must not contain the word "Obsidian" (implied by the plugin directory)');
assert.ok(!/\bplugin\b/i.test(manifest.description), 'manifest.description must not contain the word "plugin"');
assert.ok(!/obsidian/i.test(manifest.name), 'manifest.name must not contain "Obsidian"');
assert.ok(!/\bplugin\b/i.test(manifest.name), 'manifest.name must not contain "plugin"');
assert.ok(!/obsidian/i.test(manifest.id), 'manifest.id must not contain "obsidian"');
assert.ok(!/plugin/i.test(manifest.id), 'manifest.id must not contain "plugin"');

// --- Shape -------------------------------------------------------------------
assert.ok(/^[a-z0-9-]+$/.test(manifest.id), "manifest.id must be lowercase letters/digits/hyphens");
assert.ok(manifest.minAppVersion && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), "manifest.minAppVersion must be set (x.y.z)");
assert.ok(manifest.author, "manifest.author must be set");
assert.equal(typeof manifest.isDesktopOnly, "boolean", "manifest.isDesktopOnly must be a boolean");

// --- Release consistency (tag == manifest version, listed in versions.json) --
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must be x.y.z");
assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
assert.ok(versions[manifest.version], `versions.json must contain an entry for ${manifest.version}`);
// Equality, not truthiness. versions.json is what Obsidian's updater consults to
// decide who may receive a release: copy the previous line forward while bumping
// minAppVersion and the plugin is offered to users whose Obsidian then refuses
// to load it. The old check passed happily in exactly that case.
assert.equal(
  versions[manifest.version],
  manifest.minAppVersion,
  `versions.json["${manifest.version}"] must equal manifest.minAppVersion (${manifest.minAppVersion})`
);
for (const [version, minApp] of Object.entries(versions)) {
  assert.ok(/^\d+\.\d+\.\d+$/.test(version), `versions.json key "${version}" must be x.y.z`);
  assert.ok(/^\d+\.\d+\.\d+$/.test(minApp), `versions.json["${version}"] must be x.y.z`);
}

// Every command name the README tells a user to run must actually exist.
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
const commandNames = [...mainSource.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
assert.ok(commandNames.length >= 6, "expected to find the registered command names in main.ts");
for (const quoted of [...readme.matchAll(/\*\*([A-Z][^*]{4,60})\*\*/g)].map((match) => match[1])) {
  if (!/^Export |^Show |^Create |^Open |^Copy /.test(quoted)) continue;
  assert.ok(
    commandNames.includes(quoted),
    `README tells the user to run "${quoted}", which is not a registered command. Registered: ${commandNames.join(", ")}`
  );
}

console.log("manifest contract tests passed");

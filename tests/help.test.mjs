import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { build } from "esbuild";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1"));
const outfile = path.join(os.tmpdir(), `task-calendar-help-${Date.now()}.mjs`);

await build({
  entryPoints: [path.join(root, "src/core/help.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2018",
  outfile,
});

const help = await import(`file://${outfile.replace(/\\/g, "/")}`);

for (const app of ["Google Calendar", "Apple Calendar", "Outlook", "TickTick"]) {
  assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes(app), `guide must cover ${app}`);
}

// The guide must reflect the real defaults, and must explain subscribing —
// importing once is the workflow users complain about.
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Calendar/tasks.ics"));
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Calendar/current-note.ics"));
assert.ok(/subscrib/i.test(help.IMPORT_GUIDE_MARKDOWN), "the guide must explain subscribing, not only importing");
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Show last export report"), "users need to be told how to find skipped tasks");

// Every syntax the sample advertises has to be syntax the parser accepts; the
// core test suite covers the parsing, this covers the advertising.
for (const snippet of ["📅 2026-08-01", "[due:: 2026-08-02]", "[start:: 14:15]", "[duration:: 1h]", "[reminder:: 10m]", "[end:: 2026-08-05]", "🔁 every week on Monday", "⏳ 2026-08-04"]) {
  assert.ok(help.SAMPLE_TASK_NOTE.includes(snippet), `sample note must demonstrate ${snippet}`);
}
for (const state of ["- [x]", "- [-]", "- [/]"]) {
  assert.ok(help.SAMPLE_TASK_NOTE.includes(state), `sample note must demonstrate the ${state} checkbox state`);
}

fs.unlinkSync(outfile);
console.log("help tests passed");

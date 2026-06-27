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

assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Google Calendar"));
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Apple Calendar"));
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("Outlook"));
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes("TickTick"));
assert.ok(help.IMPORT_GUIDE_MARKDOWN.includes(".task-calendar-bridge/tasks.ics"));

assert.ok(help.SAMPLE_TASK_NOTE.includes("📅 2026-08-01"));
assert.ok(help.SAMPLE_TASK_NOTE.includes("[due:: 2026-08-02]"));
assert.ok(help.SAMPLE_TASK_NOTE.includes("[start:: 14:15]"));
assert.ok(help.SAMPLE_TASK_NOTE.includes("[duration:: 1h]"));
assert.ok(help.SAMPLE_TASK_NOTE.includes("[reminder:: 10m]"));

fs.unlinkSync(outfile);
console.log("help tests passed");

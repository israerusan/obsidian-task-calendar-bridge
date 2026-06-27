import esbuild from "esbuild";
import process from "process";

const prod = process.argv.includes("production");

const context = await esbuild.context({
  banner: {
    js: "/* Task Calendar Bridge */",
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "child_process", "util"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

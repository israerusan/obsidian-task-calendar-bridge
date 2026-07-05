import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * Runs the SAME ruleset as Obsidian's automated community-plugin review
 * (eslint-plugin-obsidianmd) so review failures are caught locally before a release.
 * `npm run lint` is a hard gate (`--max-warnings 0`); a warning can still block review.
 */
export default tseslint.config(
	{
		ignores: [
			"main.js",
			"dist/**",
			"node_modules/**",
			"tests/**",
			"scripts/**",
			"esbuild.config.mjs",
			"version-bump.mjs",
			"eslint.config.mjs",
			"src/**/*.mjs",
			"src/**/*.d.mts",
		],
	},
	// The Obsidian review bot's ruleset: manifest validation, settings-tab headings,
	// static-style assignment, forbidden elements, sentence-case, command naming, etc.
	// (It already brings typescript-eslint's non-type-checked base rules.)
	...obsidianmd.configs.recommended,
	// Enable type-aware parsing on the plugin source only, so the JS/JSON config files
	// above are never parsed with type info.
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// `ui/sentence-case` with enforceCamelCaseLower fires on our product name
			// ("Task Calendar Bridge") and proper nouns (Pro, ICS, Markdown, Google
			// Calendar) — lowercasing them would be wrong, and the actual review does
			// not flag these strings. Setting NAMES are already sentence case.
			"obsidianmd/ui/sentence-case": "off",
			// Advises the declarative settings API added in Obsidian 1.13.0; this plugin
			// targets minAppVersion 1.5.0 and uses the classic display() settings tab.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			// The source already builds its DOM with createEl/createDiv/setText (no raw
			// createElement, no HTML sinks), so this rule is a no-op today; kept off to
			// match the shared baseline and stay green if a detached-element helper (built
			// with the terse createElement form, text-only, no XSS surface) is added later.
			"obsidianmd/prefer-create-el": "off",
		},
	}
);

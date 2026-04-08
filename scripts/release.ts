/**
 * @description リリース準備とパブリッシュのCLI
 *
 * Usage:
 *   bun scripts/release.ts version patch          # stable release
 *   bun scripts/release.ts version patch --dev    # dev release
 *   bun scripts/release.ts publish                # publish stable
 *   bun scripts/release.ts publish --dev          # publish dev
 *   Add --dry-run to preview without making changes.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

function run(cmd: string) {
	console.log(`> ${cmd}`);
	return execSync(cmd, { stdio: "inherit" });
}

function runCapture(cmd: string): string {
	console.log(`> ${cmd}`);
	return execSync(cmd, { encoding: "utf-8" }).trim();
}

function getVersion(): string {
	const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
	return pkg.version;
}

function checkGitClean() {
	const status = runCapture("git status --porcelain");
	if (status !== "") {
		throw new Error(`git status is not clean:\n${status}`);
	}
}

function checkUnreleasedHasItems(content: string) {
	const lines = content.split("\n");
	let inUnreleased = false;
	const items: string[] = [];

	for (const line of lines) {
		if (line === "## Unreleased") {
			inUnreleased = true;
			continue;
		}
		if (inUnreleased && line.startsWith("##")) break;
		if (inUnreleased && line.startsWith("-")) items.push(line);
	}

	for (const item of items) {
		if (item.includes("No unreleased changes")) {
			throw new Error(
				"Please update 'No unreleased changes' with changelog items.",
			);
		}
	}
	if (items.length === 0) {
		throw new Error(
			"Please add changelog items under the 'Unreleased' header.",
		);
	}
}

function version(update: string, dev: boolean, dryRun: boolean) {
	if (!["major", "minor", "patch"].includes(update)) {
		throw new Error("update must be 'major', 'minor', or 'patch'");
	}

	checkGitClean();

	if (dev) {
		const current = getVersion();
		if (current.includes("-dev.")) {
			run("npm version prerelease --no-git-tag-version");
		} else {
			run(`npm version pre${update} --preid=dev --no-git-tag-version`);
		}

		const newVersion = getVersion();
		run("git diff");

		const msg = `[DEV-RELEASE] Prepare dev release for v${newVersion}`;
		if (dryRun) {
			console.log(`\nDRY RUN: Would create commit with message:\n${msg}`);
			run("git restore -- package.json");
		} else {
			run("git add package.json");
			run(`git commit -m "${msg}"`);
		}
	} else {
		const changelog = readFileSync("CHANGELOG.md", "utf-8");
		checkUnreleasedHasItems(changelog);

		run(`npm version ${update} --no-git-tag-version`);
		const newVersion = getVersion();
		const header = `v${newVersion}`;

		const newChangelog = changelog.replace(
			"## Unreleased",
			`## Unreleased\n\nNo unreleased changes.\n\n## ${header}`,
		);
		writeFileSync("CHANGELOG.md", newChangelog);

		run("git diff");
		run("git add package.json CHANGELOG.md");

		const msg = `[RELEASE] Prepare release for ${header}`;
		if (dryRun) {
			console.log(`\nDRY RUN: Would create commit with message:\n${msg}`);
			run("git reset HEAD");
			run("git restore -- package.json CHANGELOG.md");
		} else {
			run(`git commit -m "${msg}"`);
		}
	}
}

function publish(dev: boolean, dryRun: boolean) {
	const ver = getVersion();
	const tags = [ver, `v${ver}`];

	if (dryRun) {
		console.log("\nDRY RUN: Would execute the following operations:");
		console.log("- git push (push version commit)");
		console.log(`- Create and push git tags: ${tags.join(" ")}`);
		console.log(dev ? "- npm publish --tag next" : "- npm publish");
		return;
	}

	run("git push");
	for (const tag of tags) {
		run(`git tag ${tag}`);
	}
	run("git push --tags");

	if (dev) {
		run("npm publish --tag next");
	} else {
		run("npm publish");
	}
}

const { positionals, values } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		dev: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

const command = positionals[0];
const isDev = values.dev ?? false;
const isDryRun = values["dry-run"] ?? false;

switch (command) {
	case "version": {
		const update = positionals[1];
		if (!update)
			throw new Error(
				"Usage: bun scripts/release.ts version <patch|minor|major>",
			);
		version(update, isDev, isDryRun);
		break;
	}
	case "publish":
		publish(isDev, isDryRun);
		break;
	default:
		throw new Error("Usage: bun scripts/release.ts <version|publish>");
}

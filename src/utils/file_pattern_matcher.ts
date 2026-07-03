import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * @description Matcher that checks file paths against Docker-ignore-style glob patterns
 */
export class FilePatternMatcher {
	readonly #patterns?: string[];
	#filePath?: string;
	#compiled?: CompiledPattern[];
	#inverted = false;

	constructor(...patterns: string[]) {
		this.#patterns = patterns;
	}

	/**
	 * @description Creates a matcher that lazily loads patterns from an ignore file
	 */
	static fromFile(filePath: string): FilePatternMatcher {
		const matcher = new FilePatternMatcher();
		matcher.#filePath = filePath;
		return matcher;
	}

	static from_file(filePath: string): FilePatternMatcher {
		return FilePatternMatcher.fromFile(filePath);
	}

	/**
	 * @description Inverts the matcher
	 */
	invert(): FilePatternMatcher {
		const matcher = new FilePatternMatcher(...(this.#patterns ?? []));
		if (this.#filePath !== undefined) {
			return new InvertedFilePatternMatcher(
				FilePatternMatcher.fromFile(this.#filePath),
			);
		}
		matcher.#inverted = !this.#inverted;
		return matcher;
	}

	/**
	 * @description Returns whether directory traversal can be safely pruned
	 */
	canPruneDirectories(): boolean {
		return (
			!this.#load().some((pattern) => pattern.exclusion) && !this.#inverted
		);
	}

	can_prune_directories(): boolean {
		return this.canPruneDirectories();
	}

	/**
	 * @description Returns whether filePath matches any pattern
	 */
	matches(filePath: string): boolean {
		const result = this.#matches(filePath);
		return this.#inverted ? !result : result;
	}

	#matches(filePath: string): boolean {
		let matched = false;
		const normalized = normalizePath(filePath);
		if (normalized === ".") return false;

		const parent = path.posix.dirname(normalized);
		const parentDirs = parent === "." ? [] : parent.split("/");

		for (const pattern of this.#load()) {
			if (pattern.exclusion !== matched) continue;

			let patternMatched = pattern.regex.test(normalized);
			if (!patternMatched && parentDirs.length > 0) {
				for (let i = 0; i < parentDirs.length; i++) {
					if (pattern.regex.test(parentDirs.slice(0, i + 1).join("/"))) {
						patternMatched = true;
						break;
					}
				}
			}
			if (patternMatched) matched = !pattern.exclusion;
		}

		return matched;
	}

	#load(): CompiledPattern[] {
		if (this.#compiled) return this.#compiled;
		const patternStrings =
			this.#filePath !== undefined
				? readFileSync(this.#filePath, "utf8").split(/\r?\n/)
				: (this.#patterns ?? []);
		this.#compiled = patternStrings.flatMap(compilePattern);
		return this.#compiled;
	}
}

class InvertedFilePatternMatcher extends FilePatternMatcher {
	readonly #inner: FilePatternMatcher;

	constructor(inner: FilePatternMatcher) {
		super();
		this.#inner = inner;
	}

	override canPruneDirectories(): boolean {
		return false;
	}

	override matches(filePath: string): boolean {
		return !this.#inner.matches(filePath);
	}
}

type CompiledPattern = {
	exclusion: boolean;
	regex: RegExp;
};

function compilePattern(rawPattern: string): CompiledPattern[] {
	let pattern = rawPattern
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/g, "");
	if (!pattern || pattern.startsWith("#")) return [];

	let exclusion = false;
	if (pattern.startsWith("!")) {
		if (pattern === "!") throw new Error('Illegal exclusion pattern: "!"');
		exclusion = true;
		pattern = pattern.slice(1);
	}

	return [{ exclusion, regex: globToRegExp(normalizePath(pattern)) }];
}

function normalizePath(filePath: string): string {
	return path.posix
		.normalize(filePath.replaceAll("\\", "/"))
		.replace(/^\/+/, "");
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		const next = pattern[i + 1];
		const afterNext = pattern[i + 2];
		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			i += 2;
		} else if (char === "*" && next === "*") {
			source += ".*";
			i++;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegExp(char ?? "");
		}
	}
	source += "$";
	return new RegExp(source);
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

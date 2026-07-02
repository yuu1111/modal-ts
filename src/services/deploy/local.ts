import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { InvalidError } from "@/core/errors";
import type { Image } from "@/services/image/image";
import type { Schedule } from "@/services/schedule/schedule";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import type { Secret } from "@/services/secret/secret";
import { FilePatternMatcher } from "@/utils/file_pattern_matcher";

const require = createRequire(`${process.cwd()}${path.sep}`);

export type LocalFunctionHandler = (...args: unknown[]) => unknown;
export type LocalClassConstructor = {
	readonly name: string;
	readonly prototype: object;
	new (...args: never[]): unknown;
	toString(): string;
};

export type LocalFunctionSource =
	| LocalFunctionHandler
	| {
			entrypoint: string;
			exportName?: string;
			sourceDir?: string;
			ignore?: string[] | FilePatternMatcher;
			bundle?: boolean;
			external?: string[];
	  };

export type LocalClassSource =
	| LocalClassConstructor
	| {
			entrypoint: string;
			exportName?: string;
			methods: string[];
			sourceDir?: string;
			ignore?: string[] | FilePatternMatcher;
			bundle?: boolean;
			external?: string[];
	  };

export type LocalFunctionParams = {
	name?: string;
	image?: Image;
	imageId?: string;
	mountIds?: string[];
	secretIds?: string[];
	secrets?: Secret[];
	env?: Record<string, string>;
	minContainers?: number;
	schedule?: Schedule;
	schedulerPlacement?: SchedulerPlacement;
	experimentalOptions?: Record<string, string>;
};

export type LocalClassParams = Omit<LocalFunctionParams, "name"> & {
	name?: string;
	methods?: string[];
};

export type LocalFunctionRuntime = {
	moduleName: string;
	implementationName: string;
	mountFiles: Array<{ remotePath: string; content: string | Uint8Array }>;
};

function safeIdentifier(value: string, fallback: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
	const prefixed = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
	return prefixed || fallback;
}

function localModuleName(name: string): string {
	return `modal_ts_local_${safeIdentifier(name, "handler").toLowerCase()}`;
}

function inlineSource(value: { toString(): string }): string {
	return `export default ${value.toString()};\n`;
}

function importSource(
	remoteEntrypointPath: string,
	root: string,
	exportName = "default",
): string {
	const importPath = `./${path.posix.relative(root, remoteEntrypointPath)}`;
	return [
		`export { ${exportName} as default } from ${JSON.stringify(importPath)};`,
		"",
	].join("\n");
}

function transpileTypeScript(source: string): string {
	try {
		const ts = require("typescript") as typeof import("typescript");
		return ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
				esModuleInterop: true,
				sourceMap: false,
			},
		}).outputText;
	} catch {
		throw new InvalidError(
			"TypeScript entrypoints require the 'typescript' package to be installed locally so modal-ts can transpile them before upload.",
		);
	}
}

function bundleEntrypoint(
	entrypoint: string,
	external: string[] | undefined,
): string {
	let esbuild: typeof import("esbuild");
	try {
		esbuild = require("esbuild") as typeof import("esbuild");
	} catch {
		throw new InvalidError(
			"Bundled local entrypoints require the 'esbuild' package to be installed locally so modal-ts can bundle them before upload.",
		);
	}

	try {
		const result = esbuild.buildSync({
			entryPoints: [entrypoint],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node18",
			write: false,
			sourcemap: false,
			external: external ?? [],
		});
		const output = result.outputFiles[0];
		if (output === undefined) {
			throw new InvalidError("esbuild did not produce a bundled entrypoint.");
		}
		return output.text;
	} catch (error) {
		if (error instanceof InvalidError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new InvalidError(
			`Failed to bundle local entrypoint '${entrypoint}': ${message}`,
		);
	}
}

function remotePathForSourceFile(root: string, relativePath: string): string {
	const parsed = path.posix.parse(relativePath.replaceAll("\\", "/"));
	const ext =
		parsed.ext === ".ts" || parsed.ext === ".tsx" ? ".mjs" : parsed.ext;
	return path.posix.join(root, "src", parsed.dir, `${parsed.name}${ext}`);
}

function mountContent(localPath: string): string | Uint8Array {
	const ext = path.extname(localPath);
	if (ext === ".ts" || ext === ".tsx") {
		return transpileTypeScript(readFileSync(localPath, "utf8"));
	}
	return readFileSync(localPath);
}

function shouldIgnoreSourceFile(
	sourceDir: string,
	filePath: string,
	ignore: string[] | FilePatternMatcher | undefined,
): boolean {
	const relativePath = path.relative(sourceDir, filePath).replaceAll("\\", "/");
	const matcher =
		ignore instanceof FilePatternMatcher
			? ignore
			: new FilePatternMatcher(...(ignore ?? ["node_modules", ".git"]));
	return matcher.matches(relativePath);
}

function walkSourceFiles(
	dir: string,
	sourceDir: string,
	ignore: string[] | FilePatternMatcher | undefined,
): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (shouldIgnoreSourceFile(sourceDir, entryPath, ignore)) continue;
		if (entry.isDirectory()) {
			files.push(...walkSourceFiles(entryPath, sourceDir, ignore));
		} else if (entry.isFile()) {
			files.push(entryPath);
		}
	}
	return files;
}

function _entrypointMounts(
	source: Exclude<LocalFunctionSource, LocalFunctionHandler>,
	root: string,
): {
	remoteEntrypointPath: string;
	mounts: Array<{ remotePath: string; content: string | Uint8Array }>;
} {
	const entrypoint = path.resolve(source.entrypoint);
	if (source.bundle === true) {
		const remotePath = `${root}/entrypoint.mjs`;
		return {
			remoteEntrypointPath: remotePath,
			mounts: [
				{
					remotePath,
					content: bundleEntrypoint(entrypoint, source.external),
				},
			],
		};
	}

	if (source.sourceDir === undefined) {
		const ext = path.extname(entrypoint);
		const remotePath =
			ext === ".ts" || ext === ".tsx"
				? `${root}/entrypoint.mjs`
				: `${root}/entrypoint${ext || ".mjs"}`;
		return {
			remoteEntrypointPath: remotePath,
			mounts: [{ remotePath, content: mountContent(entrypoint) }],
		};
	}

	const sourceDir = path.resolve(source.sourceDir);
	const relativeEntrypoint = path.relative(sourceDir, entrypoint);
	if (
		relativeEntrypoint.startsWith("..") ||
		path.isAbsolute(relativeEntrypoint)
	) {
		throw new InvalidError("entrypoint must be inside sourceDir.");
	}

	const mounts = walkSourceFiles(sourceDir, sourceDir, source.ignore).map(
		(filePath) => {
			const relativePath = path.relative(sourceDir, filePath);
			return {
				remotePath: remotePathForSourceFile(root, relativePath),
				content: mountContent(filePath),
			};
		},
	);
	return {
		remoteEntrypointPath: remotePathForSourceFile(root, relativeEntrypoint),
		mounts,
	};
}

function nodeRunnerSource(): string {
	return `import { pathToFileURL } from "node:url";

const [modulePath, exportName = "default", methodName = ""] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;

function revive(value) {
	if (Array.isArray(value)) return value.map(revive);
	if (value && typeof value === "object") {
		if (value.__modal_ts_type === "bytes" && typeof value.base64 === "string") {
			return Uint8Array.from(Buffer.from(value.base64, "base64"));
		}
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
	}
	return value;
}

function replacer(_key, value) {
	if (value instanceof Uint8Array) {
		return {
			__modal_ts_type: "bytes",
			base64: Buffer.from(value).toString("base64"),
		};
	}
	if (value instanceof ArrayBuffer) {
		return {
			__modal_ts_type: "bytes",
			base64: Buffer.from(value).toString("base64"),
		};
	}
	if (typeof value === "bigint") {
		return {
			__modal_ts_type: "bigint",
			value: value.toString(),
		};
	}
	return value;
}

for (const name of ["debug", "error", "info", "log", "warn"]) {
	console[name] = (...values) => {
		process.stderr.write(values.map((value) => {
			if (typeof value === "string") return value;
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		}).join(" ") + "\\n");
	};
}

const payload = revive(input ? JSON.parse(input) : { args: [], kwargs: {} });
const mod = await import(pathToFileURL(modulePath).href);
let target = mod[exportName] ?? mod.default;

if (methodName) {
	const ctorArgs = Array.isArray(payload.ctorArgs) ? payload.ctorArgs : [];
	const ctorKwargs = payload.ctorKwargs && Object.keys(payload.ctorKwargs).length > 0 ? [payload.ctorKwargs] : [];
	const instance = typeof target === "function" ? new target(...ctorArgs, ...ctorKwargs) : target;
	target = instance?.[methodName]?.bind(instance);
}

if (typeof target !== "function") {
	throw new Error("Local Modal handler is not callable");
}

const args = Array.isArray(payload.args) ? payload.args : [];
const kwargs = payload.kwargs && Object.keys(payload.kwargs).length > 0 ? [payload.kwargs] : [];
const result = await target(...args, ...kwargs);
process.stdout.write(JSON.stringify(result === undefined ? null : result, replacer));
`;
}

function pythonFunctionShimSource(
	functionName: string,
	handlerPath: string,
	runnerPath: string,
): string {
	return `import base64
import json
import subprocess


def _modal_ts_to_jsonable(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {
            "__modal_ts_type": "bytes",
            "base64": base64.b64encode(bytes(value)).decode("ascii"),
        }
    if isinstance(value, tuple):
        return [_modal_ts_to_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_modal_ts_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _modal_ts_to_jsonable(item) for key, item in value.items()}
    return value


def _modal_ts_from_jsonable(value):
    if isinstance(value, list):
        return [_modal_ts_from_jsonable(item) for item in value]
    if isinstance(value, dict):
        if value.get("__modal_ts_type") == "bytes":
            return base64.b64decode(value["base64"])
        if value.get("__modal_ts_type") == "bigint":
            return int(value["value"])
        return {key: _modal_ts_from_jsonable(item) for key, item in value.items()}
    return value


def ${functionName}(*args, **kwargs):
    payload = json.dumps(_modal_ts_to_jsonable({"args": args, "kwargs": kwargs}))
    proc = subprocess.run(
        ["node", ${JSON.stringify(runnerPath)}, ${JSON.stringify(handlerPath)}],
        input=payload,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return _modal_ts_from_jsonable(json.loads(proc.stdout or "null"))
`;
}

function pythonClassShimSource(
	className: string,
	methods: string[],
	handlerPath: string,
	runnerPath: string,
): string {
	const methodBodies = methods
		.map((method, index) => {
			const internalName = `_modal_ts_method_${index}`;
			return `
    def ${internalName}(self, *args, **kwargs):
        return _call_js(
            ${JSON.stringify(method)},
            args,
            kwargs,
            self._modal_ts_ctor_args,
            self._modal_ts_ctor_kwargs,
        )
`;
		})
		.join("");
	const methodAliases = methods
		.map(
			(method, index) =>
				`setattr(${className}, ${JSON.stringify(method)}, ${className}._modal_ts_method_${index})`,
		)
		.join("\n");
	return `import base64
import json
import subprocess


def _modal_ts_to_jsonable(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {
            "__modal_ts_type": "bytes",
            "base64": base64.b64encode(bytes(value)).decode("ascii"),
        }
    if isinstance(value, tuple):
        return [_modal_ts_to_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_modal_ts_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _modal_ts_to_jsonable(item) for key, item in value.items()}
    return value


def _modal_ts_from_jsonable(value):
    if isinstance(value, list):
        return [_modal_ts_from_jsonable(item) for item in value]
    if isinstance(value, dict):
        if value.get("__modal_ts_type") == "bytes":
            return base64.b64decode(value["base64"])
        if value.get("__modal_ts_type") == "bigint":
            return int(value["value"])
        return {key: _modal_ts_from_jsonable(item) for key, item in value.items()}
    return value


def _call_js(method_name, args, kwargs, ctor_args=(), ctor_kwargs=None):
    payload = json.dumps(_modal_ts_to_jsonable({
        "args": args,
        "kwargs": kwargs,
        "ctorArgs": ctor_args,
        "ctorKwargs": ctor_kwargs or {},
    }))
    proc = subprocess.run(
        ["node", ${JSON.stringify(runnerPath)}, ${JSON.stringify(handlerPath)}, "default", method_name],
        input=payload,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr)
    return _modal_ts_from_jsonable(json.loads(proc.stdout or "null"))


class ${className}:
    def __init__(self, *args, **kwargs):
        self._modal_ts_ctor_args = args
        self._modal_ts_ctor_kwargs = kwargs

${methodBodies || "    pass\n"}
${methodAliases}
`;
}

export function localFunctionRuntime(
	source: LocalFunctionSource,
	params: LocalFunctionParams = {},
): {
	functionName: string;
	moduleName: string;
	localRuntime: LocalFunctionRuntime;
} {
	const inferredName =
		typeof source === "function"
			? source.name || "handler"
			: path.basename(source.entrypoint, path.extname(source.entrypoint));
	const functionName = params.name ?? inferredName;
	const moduleName = localModuleName(functionName);
	const implementationName = safeIdentifier(functionName, "handler");
	const root = `/root/.modal_ts/${moduleName}`;
	const runnerPath = `${root}/runner.mjs`;
	const handlerPath = `${root}/handler.mjs`;
	let handlerSource: string;
	const entrypointMounts: LocalFunctionRuntime["mountFiles"] = [];
	if (typeof source === "function") {
		handlerSource = inlineSource(source);
	} else {
		const entrypoint = _entrypointMounts(source, root);
		handlerSource = importSource(
			entrypoint.remoteEntrypointPath,
			root,
			source.exportName,
		);
		entrypointMounts.push(...entrypoint.mounts);
	}
	return {
		functionName,
		moduleName,
		localRuntime: {
			moduleName,
			implementationName,
			mountFiles: [
				{ remotePath: runnerPath, content: nodeRunnerSource() },
				...entrypointMounts,
				{ remotePath: handlerPath, content: handlerSource },
				{
					remotePath: `/root/${moduleName}.py`,
					content: pythonFunctionShimSource(
						implementationName,
						handlerPath,
						runnerPath,
					),
				},
			],
		},
	};
}

export function localClassRuntime(
	source: LocalClassSource,
	params: LocalClassParams = {},
): {
	className: string;
	moduleName: string;
	methods: string[];
	localRuntime: LocalFunctionRuntime;
} {
	const inferredName =
		typeof source === "function"
			? source.name || "Service"
			: path.basename(source.entrypoint, path.extname(source.entrypoint));
	const className = params.name ?? inferredName;
	const methods =
		params.methods ??
		(typeof source === "function"
			? Object.getOwnPropertyNames(source.prototype).filter(
					(name) =>
						name !== "constructor" &&
						typeof Object.getOwnPropertyDescriptor(source.prototype, name)
							?.value === "function",
				)
			: source.methods);
	const moduleName = localModuleName(className);
	const implementationName = safeIdentifier(className, "Service");
	const root = `/root/.modal_ts/${moduleName}`;
	const runnerPath = `${root}/runner.mjs`;
	const handlerPath = `${root}/handler.mjs`;
	let handlerSource: string;
	const entrypointMounts: LocalFunctionRuntime["mountFiles"] = [];
	if (typeof source === "function") {
		handlerSource = inlineSource(source);
	} else {
		const entrypoint = _entrypointMounts(source, root);
		handlerSource = importSource(
			entrypoint.remoteEntrypointPath,
			root,
			source.exportName,
		);
		entrypointMounts.push(...entrypoint.mounts);
	}
	return {
		className,
		moduleName,
		methods,
		localRuntime: {
			moduleName,
			implementationName,
			mountFiles: [
				{ remotePath: runnerPath, content: nodeRunnerSource() },
				...entrypointMounts,
				{ remotePath: handlerPath, content: handlerSource },
				{
					remotePath: `/root/${moduleName}.py`,
					content: pythonClassShimSource(
						implementationName,
						methods,
						handlerPath,
						runnerPath,
					),
				},
			],
		},
	};
}

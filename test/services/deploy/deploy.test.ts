import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cron, Period, SchedulerPlacement } from "modal";
import { expect, test } from "vitest";
import { DataFormat } from "../../../src/generated/modal_proto/api";
import { Cls } from "../../../src/services/cls/cls";
import { deployApp } from "../../../src/services/deploy/deploy";
import { Function_ } from "../../../src/services/function/function";
import { Secret } from "../../../src/services/secret/secret";
import { createMockModalClients } from "../../support/grpc_mock";

test("deployApp passes schedule and scheduler placement", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/AppGetOrCreate", (req) => {
		expect(req).toMatchObject({
			appName: "scheduled-app",
			environmentName: "",
		});
		return { appId: "ap-123" };
	});

	mock.handleUnary("/FunctionPrecreate", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			functionName: "tick",
		});
		return { functionId: "fu-precreated" };
	});

	mock.handleUnary("/FunctionCreate", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			existingFunctionId: "fu-precreated",
			function: {
				functionName: "tick",
				schedule: {
					cron: {
						cronString: "*/5 * * * *",
						timezone: "America/New_York",
					},
				},
				schedulerPlacement: {
					regions: ["us-east-1"],
					nonpreemptible: true,
				},
			},
		});
		return {
			functionId: "fu-123",
			handleMetadata: { definitionId: "de-123" },
		};
	});

	mock.handleUnary("/AppPublish", (req) => {
		expect(req).toMatchObject({
			appId: "ap-123",
			name: "scheduled-app",
			functionIds: { tick: "fu-123" },
			definitionIds: { "fu-123": "de-123" },
		});
		return {};
	});

	const result = await deployApp(mc, {
		name: "scheduled-app",
		functions: [
			{
				functionName: "tick",
				moduleName: "scheduled",
				schedule: new Cron("*/5 * * * *", {
					timezone: "America/New_York",
				}),
				schedulerPlacement: new SchedulerPlacement({
					region: "us-east-1",
					nonpreemptible: true,
				}),
			},
		],
	});

	expect(result.functionIds).toEqual({ tick: "fu-123" });
	mock.assertExhausted();
});

test("Period builds a period schedule proto", () => {
	const schedule = new Period({ days: 1, seconds: 0.5 }).toProto();

	expect(schedule).toMatchObject({
		period: {
			days: 1,
			seconds: 0.5,
		},
	});
});

test("deployApp deploys Function.from_local with a generated shim mount", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/AppGetOrCreate", () => ({ appId: "ap-local" }));
	for (let i = 0; i < 3; i++) {
		mock.handleUnary("/MountPutFile", () => ({ exists: true }));
	}
	mock.handleUnary("/MountGetOrCreate", (req) => {
		expect(req.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filename: "/root/.modal_ts/modal_ts_local_echo/runner.mjs",
				}),
				expect.objectContaining({
					filename: "/root/.modal_ts/modal_ts_local_echo/handler.mjs",
				}),
				expect.objectContaining({
					filename: "/root/modal_ts_local_echo.py",
				}),
			]),
		);
		return { mountId: "mo-local" };
	});
	mock.handleUnary("/SecretGetOrCreate", (req) => {
		expect(req.envDict).toEqual({ GREETING: "hello" });
		return { secretId: "st-env" };
	});
	mock.handleUnary("/FunctionPrecreate", () => ({
		functionId: "fu-precreated",
	}));
	mock.handleUnary("/FunctionCreate", (req) => {
		expect(req.function).toMatchObject({
			moduleName: "modal_ts_local_echo",
			functionName: "echo",
			implementationName: "echo",
			imageId: "im-node",
			mountIds: ["mo-local"],
			secretIds: ["st-local", "st-env"],
			supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
		});
		return {
			functionId: "fu-local",
			handleMetadata: { definitionId: "de-local" },
		};
	});
	mock.handleUnary("/AppPublish", (req) => {
		expect(req.functionIds).toEqual({ echo: "fu-local" });
		return {};
	});

	const result = await deployApp(mc, {
		name: "local-app",
		functions: [
			Function_.fromLocal(
				function echo(value: unknown) {
					return value;
				},
				{
					imageId: "im-node",
					secrets: [new Secret("st-local", "local-secret")],
					env: { GREETING: "hello" },
				},
			),
		],
	});

	expect(result.functionIds).toEqual({ echo: "fu-local" });
	mock.assertExhausted();
});

test("Function.from_local mounts file entrypoints", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-entrypoint-"));
	const entrypoint = path.join(dir, "handler.mjs");
	writeFileSync(entrypoint, "export function run(value) { return value; }\n");

	mock.handleUnary("/AppGetOrCreate", () => ({ appId: "ap-local" }));
	for (let i = 0; i < 4; i++) {
		mock.handleUnary("/MountPutFile", () => ({ exists: true }));
	}
	mock.handleUnary("/MountGetOrCreate", (req) => {
		expect(req.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filename: "/root/.modal_ts/modal_ts_local_file_echo/entrypoint.mjs",
				}),
				expect.objectContaining({
					filename: "/root/.modal_ts/modal_ts_local_file_echo/handler.mjs",
				}),
			]),
		);
		return { mountId: "mo-entrypoint" };
	});
	mock.handleUnary("/FunctionPrecreate", () => ({
		functionId: "fu-precreated",
	}));
	mock.handleUnary("/FunctionCreate", (req) => {
		expect(req.function).toMatchObject({
			moduleName: "modal_ts_local_file_echo",
			functionName: "file_echo",
			implementationName: "file_echo",
			mountIds: ["mo-entrypoint"],
		});
		return { functionId: "fu-entrypoint" };
	});
	mock.handleUnary("/AppPublish", () => ({}));

	try {
		await deployApp(mc, {
			name: "local-entrypoint-app",
			functions: [
				Function_.from_local(
					{ entrypoint, exportName: "run" },
					{ name: "file_echo", imageId: "im-node" },
				),
			],
		});
		mock.assertExhausted();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Function.from_local transpiles TypeScript file entrypoints", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-ts-entrypoint-"));
	const entrypoint = path.join(dir, "handler.ts");
	writeFileSync(
		entrypoint,
		"export function run(value: string): string { return value; }\n",
	);

	try {
		const definition = Function_.fromLocal(
			{ entrypoint, exportName: "run" },
			{ name: "ts_echo", imageId: "im-node" },
		);
		const mountedEntrypoint = definition.localRuntime?.mountFiles.find((file) =>
			file.remotePath.endsWith("/entrypoint.mjs"),
		);
		expect(String(mountedEntrypoint?.content)).toContain("function run(value)");
		expect(String(mountedEntrypoint?.content)).not.toContain(": string");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Function.from_local can mount a sourceDir for relative imports", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-source-dir-"));
	const entrypoint = path.join(dir, "main.mjs");
	writeFileSync(
		entrypoint,
		"import { helper } from './helper.mjs';\nexport function run() { return helper(); }\n",
	);
	writeFileSync(
		path.join(dir, "helper.mjs"),
		"export const helper = () => 42;\n",
	);
	writeFileSync(path.join(dir, "ignored.log"), "ignored\n");

	try {
		const definition = Function_.fromLocal(
			{
				entrypoint,
				exportName: "run",
				sourceDir: dir,
				ignore: ["*.log"],
			},
			{ name: "source_dir_echo", imageId: "im-node" },
		);
		const mountedFiles = definition.localRuntime?.mountFiles ?? [];
		expect(mountedFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					remotePath:
						"/root/.modal_ts/modal_ts_local_source_dir_echo/src/main.mjs",
				}),
				expect.objectContaining({
					remotePath:
						"/root/.modal_ts/modal_ts_local_source_dir_echo/src/helper.mjs",
				}),
			]),
		);
		expect(
			mountedFiles.some((file) => file.remotePath.endsWith("ignored.log")),
		).toBe(false);
		const handler = mountedFiles.find((file) =>
			file.remotePath.endsWith("/handler.mjs"),
		);
		expect(String(handler?.content)).toContain("./src/main.mjs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Function.from_local can bundle TypeScript entrypoints with relative imports", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-bundle-"));
	const entrypoint = path.join(dir, "main.ts");
	writeFileSync(
		entrypoint,
		"import { helper } from './helper';\nexport function run(value: string): string { return helper(value); }\n",
	);
	writeFileSync(
		path.join(dir, "helper.ts"),
		"export function helper(value: string): string { return `${value}!`; }\n",
	);

	try {
		const definition = Function_.fromLocal(
			{
				entrypoint,
				exportName: "run",
				bundle: true,
			},
			{ name: "bundled_echo", imageId: "im-node" },
		);
		const mountedFiles = definition.localRuntime?.mountFiles ?? [];
		const bundledEntrypoint = mountedFiles.find((file) =>
			file.remotePath.endsWith("/entrypoint.mjs"),
		);
		const handler = mountedFiles.find((file) =>
			file.remotePath.endsWith("/handler.mjs"),
		);
		expect(String(bundledEntrypoint?.content)).toContain("function helper");
		expect(String(bundledEntrypoint?.content)).toContain("function run");
		expect(String(bundledEntrypoint?.content)).not.toContain(": string");
		expect(String(handler?.content)).toContain("./entrypoint.mjs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deployApp deploys Cls.from_local with generated class methods", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	class EchoService {
		echo(value: unknown) {
			return value;
		}
	}

	mock.handleUnary("/AppGetOrCreate", () => ({ appId: "ap-local" }));
	for (let i = 0; i < 3; i++) {
		mock.handleUnary("/MountPutFile", () => ({ exists: true }));
	}
	mock.handleUnary("/MountGetOrCreate", (req) => {
		expect(req.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filename: "/root/modal_ts_local_echoservice.py",
				}),
			]),
		);
		const pythonShim = (
			req.files as Array<{ filename: string; sha256Hex: string }>
		).find((file) => file.filename === "/root/modal_ts_local_echoservice.py");
		expect(pythonShim).toBeDefined();
		return { mountId: "mo-cls" };
	});
	mock.handleUnary("/FunctionPrecreate", () => ({
		functionId: "fu-precreated-cls",
	}));
	mock.handleUnary("/FunctionCreate", (req) => {
		expect(req.function).toMatchObject({
			moduleName: "modal_ts_local_echoservice",
			functionName: "EchoService",
			implementationName: "EchoService",
			imageId: "im-node",
			mountIds: ["mo-cls"],
			isClass: true,
			supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
			methodDefinitions: {
				echo: {
					functionName: "EchoService.echo",
					supportedOutputFormats: [DataFormat.DATA_FORMAT_CBOR],
				},
			},
		});
		return {
			functionId: "fu-cls",
			handleMetadata: { definitionId: "de-cls" },
		};
	});
	mock.handleUnary("/ClassCreate", () => ({ classId: "cs-local" }));
	mock.handleUnary("/AppPublish", (req) => {
		expect(req.classIds).toEqual({ EchoService: "cs-local" });
		return {};
	});

	const result = await deployApp(mc, {
		name: "local-cls-app",
		classes: [Cls.fromLocal(EchoService, { imageId: "im-node" })],
	});

	expect(result.classIds).toEqual({ EchoService: "cs-local" });
	mock.assertExhausted();
});

test("Cls.from_local shim preserves constructor parameters", () => {
	class Greeter {
		constructor(readonly prefix: string) {}

		greet(name: string) {
			return `${this.prefix} ${name}`;
		}
	}

	const definition = Cls.fromLocal(Greeter, { imageId: "im-node" });
	const runner = definition.localRuntime?.mountFiles.find((file) =>
		file.remotePath.endsWith("/runner.mjs"),
	);
	const shim = definition.localRuntime?.mountFiles.find(
		(file) => file.remotePath === "/root/modal_ts_local_greeter.py",
	);
	expect(runner?.content).toContain("new target(...ctorArgs, ...ctorKwargs)");
	expect(runner?.content).toContain('for (const name of ["debug"');
	expect(runner?.content).toContain('__modal_ts_type: "bytes"');
	expect(shim?.content).toContain("def __init__(self, *args, **kwargs):");
	expect(shim?.content).toContain("self._modal_ts_ctor_args");
	expect(shim?.content).toContain("ctorArgs");
	expect(shim?.content).toContain('value.get("__modal_ts_type") == "bytes"');
});

test("Cls.from_local shim aliases non-identifier JavaScript method names", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-cls-entrypoint-"));
	const entrypoint = path.join(dir, "service.mjs");
	writeFileSync(
		entrypoint,
		"export default class Service { ['dash-name']() { return 'ok'; } }\n",
	);

	try {
		const definition = Cls.fromLocal(
			{ entrypoint, exportName: "default", methods: ["dash-name"] },
			{ imageId: "im-node" },
		);
		const shim = definition.localRuntime?.mountFiles.find(
			(file) => file.remotePath === "/root/modal_ts_local_service.py",
		);
		expect(shim?.content).toContain("def _modal_ts_method_0");
		expect(shim?.content).toContain(
			'setattr(service, "dash-name", service._modal_ts_method_0)',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Cls.from_local can bundle TypeScript class entrypoints", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-local-cls-bundle-"));
	const entrypoint = path.join(dir, "service.ts");
	writeFileSync(
		entrypoint,
		"import { suffix } from './suffix';\nexport default class Service { echo(value: string): string { return `${value}${suffix}`; } }\n",
	);
	writeFileSync(path.join(dir, "suffix.ts"), "export const suffix = '!';\n");

	try {
		const definition = Cls.fromLocal(
			{
				entrypoint,
				exportName: "default",
				methods: ["echo"],
				bundle: true,
			},
			{ imageId: "im-node" },
		);
		const mountedFiles = definition.localRuntime?.mountFiles ?? [];
		const bundledEntrypoint = mountedFiles.find((file) =>
			file.remotePath.endsWith("/entrypoint.mjs"),
		);
		const handler = mountedFiles.find((file) =>
			file.remotePath.endsWith("/handler.mjs"),
		);
		expect(String(bundledEntrypoint?.content)).toContain("Service");
		expect(String(bundledEntrypoint?.content)).toContain("suffix");
		expect(String(bundledEntrypoint?.content)).not.toContain(": string");
		expect(String(handler?.content)).toContain("./entrypoint.mjs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

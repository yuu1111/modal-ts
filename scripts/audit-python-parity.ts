import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

type ClassMembers = {
	methods: string[];
	staticMethods: string[];
	properties: string[];
};

type LocalApi = {
	indexExports: string[];
	classes: Record<string, ClassMembers>;
};

type PythonApi = {
	all: string[];
	classes: Record<string, ClassMembers>;
};

const upstreamDir =
	process.env.MODAL_CLIENT_DIR ?? path.join(tmpdir(), "modal-client-parity");
const intentionalNonParity = new Set([
	"_Function.app",
	"_Cls.__call__",
	"_AbstractVolumeUploadContextManager.resolve",
	"_VolumeUploadContextManager.resolve",
	"_VolumeUploadContextManager2.resolve",
]);

const pythonClassMap: Record<string, string> = {
	_Image: "Image",
	_Server: "Server",
	_Workspace: "Workspace",
	_WorkspaceMembersManager: "WorkspaceMembersManager",
	_WorkspaceProxyTokenManager: "WorkspaceProxyTokenManager",
	_WorkspaceBillingManager: "WorkspaceBillingManager",
	_WorkspaceSettingsManager: "WorkspaceSettingsManager",
	_Environment: "Environment",
	_EnvironmentMembersManager: "EnvironmentMembersManager",
	_EnvironmentBillingManager: "EnvironmentBillingManager",
	_Function: "Function_",
	_FunctionCall: "FunctionCall",
	_Cls: "Cls",
	_Obj: "ClsInstance",
	_Sandbox: "Sandbox",
	_SidecarContainer: "SidecarContainer",
	_SidecarManager: "SidecarService",
	_Volume: "Volume",
	_AbstractVolumeUploadContextManager: "VolumeBatchUpload",
	_VolumeUploadContextManager: "VolumeBatchUpload",
	_VolumeUploadContextManager2: "VolumeBatchUpload",
	_Queue: "Queue",
	_Dict: "Dict",
	_NetworkFileSystem: "NetworkFileSystem",
	_Secret: "Secret",
	_Proxy: "Proxy",
	_SandboxSnapshot: "SandboxSnapshot",
	Probe: "Probe",
	Cron: "Cron",
	Period: "Period",
	SchedulerPlacement: "SchedulerPlacement",
	Retries: "Retries",
	_CloudBucketMount: "CloudBucketMount",
};

const aliasRequiredClasses = [
	"Image",
	"Sandbox",
	"Queue",
	"Dict",
	"Volume",
	"NetworkFileSystem",
	"Secret",
	"Workspace",
	"Function_",
	"Cls",
	"FunctionCall",
	"Server",
	"Environment",
	"SandboxSnapshot",
	"SidecarContainer",
];

const serviceHandlePairs: Record<string, string> = {
	ClsService: "Cls",
	DictService: "Dict",
	EnvironmentService: "Environment",
	FunctionCallService: "FunctionCall",
	FunctionService: "Function_",
	ImageService: "Image",
	NetworkFileSystemService: "NetworkFileSystem",
	ProxyService: "Proxy",
	QueueService: "Queue",
	SandboxService: "Sandbox",
	SecretService: "Secret",
	ServerService: "Server",
	VolumeService: "Volume",
	WorkspaceService: "Workspace",
};

const serviceOnlyReviewed = new Set([
	"NetworkFileSystemService.create",
	"NetworkFileSystemService.list",
	"SandboxService.experimentalCreate",
	"SandboxService.experimentalList",
]);

function ensureUpstream(): void {
	if (existsSync(path.join(upstreamDir, "py", "modal", "__init__.py"))) {
		if (process.env.MODAL_CLIENT_DIR === undefined) {
			execFileSync("git", ["-C", upstreamDir, "pull", "--ff-only"], {
				stdio: "inherit",
			});
		}
		return;
	}
	execFileSync(
		"git",
		[
			"clone",
			"--depth=1",
			"https://github.com/modal-labs/modal-client.git",
			upstreamDir,
		],
		{ stdio: "inherit" },
	);
}

function read(filePath: string): string {
	return readFileSync(filePath, "utf8");
}

function walk(dir: string): string[] {
	const entries = ts.sys.readDirectory(
		dir,
		[".ts"],
		["generated", "node_modules", "dist", ".typedoc"],
	);
	return entries.filter((file) => file.endsWith(".ts"));
}

function collectIndexExports(filePath: string): string[] {
	const sf = ts.createSourceFile(
		filePath,
		read(filePath),
		ts.ScriptTarget.Latest,
		true,
	);
	const exports: string[] = [];
	for (const statement of sf.statements) {
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) {
				exports.push(element.name.text);
			}
		}
	}
	return exports.sort();
}

function collectLocalApi(): LocalApi {
	const classes: Record<string, ClassMembers> = {};
	for (const filePath of walk(path.join(process.cwd(), "src"))) {
		const sf = ts.createSourceFile(
			filePath,
			read(filePath),
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node: ts.Node) => {
			if (ts.isClassDeclaration(node) && node.name !== undefined) {
				const existing = classes[node.name.text] ?? {
					methods: [],
					staticMethods: [],
					properties: [],
				};
				for (const member of node.members) {
					const name = member.name;
					if (
						name === undefined ||
						(!ts.isIdentifier(name) && !ts.isStringLiteral(name))
					) {
						continue;
					}
					if (ts.isMethodDeclaration(member)) {
						if (
							member.modifiers?.some(
								(modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
							)
						) {
							existing.staticMethods.push(name.text);
						}
						existing.methods.push(name.text);
					} else if (
						ts.isGetAccessorDeclaration(member) ||
						ts.isPropertyDeclaration(member)
					) {
						existing.properties.push(name.text);
					}
				}
				classes[node.name.text] = {
					methods: unique(existing.methods),
					staticMethods: unique(existing.staticMethods),
					properties: unique(existing.properties),
				};
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return {
		indexExports: collectIndexExports(
			path.join(process.cwd(), "src", "index.ts"),
		),
		classes,
	};
}

function collectUsedClientMethods(dir: string): Set<string> {
	const methods = new Set<string>();
	for (const filePath of walk(dir)) {
		const source = read(filePath);
		for (const match of source.matchAll(/\.([a-z][A-Za-z0-9_]*)\s*\(/g)) {
			methods.add(match[1]);
		}
	}
	return methods;
}

function collectRpcClientMethods(): string[] {
	const source = read(
		path.join(process.cwd(), "src", "generated", "modal_proto", "api.ts"),
	);
	return unique(
		[...source.matchAll(/name:\s*"([A-Za-z0-9_]+)"/g)]
			.map((match) => match[1])
			.map((name) => name[0].toLowerCase() + name.slice(1)),
	);
}

function collectPythonApi(): PythonApi {
	const modalRoot = path.join(upstreamDir, "py", "modal");
	const init = read(path.join(modalRoot, "__init__.py"));
	const allMatch = init.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
	const all = allMatch
		? [...allMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
		: [];
	const classes: Record<string, ClassMembers> = {};
	const files = [
		"_image.py",
		"_server.py",
		"_workspace.py",
		"_environments.py",
		"_functions.py",
		"cls.py",
		"sandbox.py",
		"volume.py",
		"queue.py",
		"dict.py",
		"network_file_system.py",
		"secret.py",
		"proxy.py",
		"snapshot.py",
		"schedule.py",
		"scheduler_placement.py",
		"retries.py",
		"cloud_bucket_mount.py",
	];
	for (const file of files) {
		const filePath = path.join(modalRoot, file);
		if (!existsSync(filePath)) continue;
		const source = read(filePath);
		for (const classMatch of source.matchAll(
			/^class\s+([A-Za-z_]\w*)[\s\S]*?(?=^class\s+|^def\s+|z)/gm,
		)) {
			const className = classMatch[1];
			const body = classMatch[0];
			const members = classes[className] ?? {
				methods: [],
				staticMethods: [],
				properties: [],
			};
			for (const methodMatch of body.matchAll(
				/^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
			)) {
				const name = methodMatch[1];
				if (name.startsWith("_") && name !== "__call__") continue;
				const before = body.slice(0, methodMatch.index);
				const decoratorBlock = before.slice(before.lastIndexOf("\n    @"));
				if (
					decoratorBlock.includes("@property") ||
					decoratorBlock.includes("@classproperty")
				) {
					members.properties.push(name);
				} else {
					members.methods.push(name);
				}
			}
			classes[className] = {
				methods: unique(members.methods),
				staticMethods: unique(members.staticMethods),
				properties: unique(members.properties),
			};
		}
	}
	return { all: unique(all), classes };
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function camel(name: string): string {
	return name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function hasMember(
	local: LocalApi,
	className: string,
	memberName: string,
): boolean {
	const cls = local.classes[className] ?? { methods: [], properties: [] };
	const names = new Set([
		...cls.methods,
		...cls.staticMethods,
		...cls.properties,
	]);
	return names.has(memberName) || names.has(camel(memberName));
}

function main(): void {
	ensureUpstream();
	const local = collectLocalApi();
	const python = collectPythonApi();
	const upstreamJsExports = collectIndexExports(
		path.join(upstreamDir, "js", "src", "index.ts"),
	);
	const localUsedClientMethods = collectUsedClientMethods(
		path.join(process.cwd(), "src"),
	);
	const upstreamJsUsedClientMethods = collectUsedClientMethods(
		path.join(upstreamDir, "js", "src"),
	);
	const missingUpstreamJsRpcs = collectRpcClientMethods().filter(
		(method) =>
			upstreamJsUsedClientMethods.has(method) &&
			!localUsedClientMethods.has(method),
	);

	const localExports = new Set(local.indexExports);
	const topLevelAliases = new Map([
		["Client", "ModalClient"],
		["Function", "Function_"],
		["Error", "ModalError"],
	]);
	const missingPythonExports = python.all.filter(
		(name) =>
			!localExports.has(name) &&
			!localExports.has(topLevelAliases.get(name) ?? ""),
	);
	const missingJsExports = upstreamJsExports.filter(
		(name) => !localExports.has(name),
	);
	const missingMembers: string[] = [];
	for (const [pythonClass, localClass] of Object.entries(pythonClassMap)) {
		const members = python.classes[pythonClass];
		if (members === undefined) continue;
		for (const member of unique([...members.methods, ...members.properties])) {
			const key = `${pythonClass}.${member}`;
			if (intentionalNonParity.has(key)) continue;
			if (!hasMember(local, localClass, member)) {
				missingMembers.push(`${pythonClass} -> ${localClass}.${member}`);
			}
		}
	}

	const missingCamelAliases: string[] = [];
	for (const className of aliasRequiredClasses) {
		const members = local.classes[className];
		if (members === undefined) continue;
		for (const member of unique([...members.methods, ...members.properties])) {
			if (!member.includes("_") || member.startsWith("_")) continue;
			const camelName = camel(member);
			if (camelName !== member && !hasMember(local, className, camelName)) {
				missingCamelAliases.push(`${className}.${member} -> ${camelName}`);
			}
		}
	}

	const missingServiceHandleHelpers: string[] = [];
	for (const [serviceClass, handleClass] of Object.entries(
		serviceHandlePairs,
	)) {
		const service = local.classes[serviceClass];
		const handle = local.classes[handleClass];
		if (service === undefined || handle === undefined) continue;
		for (const method of service.methods) {
			if (method.startsWith("#") || method === "constructor") continue;
			const key = `${serviceClass}.${method}`;
			if (serviceOnlyReviewed.has(key)) continue;
			if (
				!handle.staticMethods.includes(method) &&
				!hasMember(local, handleClass, method)
			) {
				missingServiceHandleHelpers.push(`${key} -> ${handleClass}.${method}`);
			}
		}
	}

	const sections = [
		["Python __all__ missing", missingPythonExports],
		["Upstream JS index missing", missingJsExports],
		["Python class members missing", missingMembers],
		["camelCase aliases missing", missingCamelAliases],
		[
			"Local service helpers missing handle static",
			missingServiceHandleHelpers,
		],
		["Upstream JS RPC usage missing", missingUpstreamJsRpcs],
	] as const;

	for (const [title, items] of sections) {
		console.log(`\n${title}:`);
		console.log(
			items.length === 0
				? "  (none)"
				: items.map((item) => `  - ${item}`).join("\n"),
		);
	}

	const failed = sections.some(([, items]) => items.length > 0);
	if (failed) process.exitCode = 1;
}

main();

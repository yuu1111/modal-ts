import { createHash } from "node:crypto";
import {
	AppState,
	DataFormat,
	Function_DefinitionType,
	Function_FunctionType,
	ObjectCreationType,
	type WebhookConfig,
} from "../proto/modal_proto/api";
import type { ModalClient, ModalGrpcClient } from "./client";

export interface DeployAppParams {
	name: string;
	environment?: string;
	functions?: DeployFunctionParams[];
	classes?: DeployClassParams[];
}

export interface DeployFunctionParams {
	functionName: string;
	moduleName: string;
	imageId?: string;
	mountIds?: string[];
	secretIds?: string[];
	minContainers?: number;
	experimentalOptions?: Record<string, string>;
	webhookConfig?: Partial<WebhookConfig>;
}

export interface DeployClassParams {
	className: string;
	moduleName: string;
	methods: string[];
	imageId?: string;
	mountIds?: string[];
	secretIds?: string[];
	minContainers?: number;
	experimentalOptions?: Record<string, string>;
}

export interface MountFileEntry {
	remotePath: string;
	content: string | Uint8Array;
}

export interface DeployResult {
	appId: string;
	functionIds: Record<string, string>;
	classIds: Record<string, string>;
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export async function createMount(
	cpClient: ModalGrpcClient,
	appId: string,
	files: MountFileEntry[],
): Promise<string> {
	const encoder = new TextEncoder();
	const mountFiles = [];

	for (const file of files) {
		const data =
			typeof file.content === "string"
				? encoder.encode(file.content)
				: file.content;
		const hash = sha256(data);

		const putResp = await cpClient.mountPutFile({ sha256Hex: hash });

		if (!putResp.exists) {
			await cpClient.mountPutFile({ sha256Hex: hash, data });
		}

		mountFiles.push({ filename: file.remotePath, sha256Hex: hash });
	}

	const resp = await cpClient.mountGetOrCreate({
		appId,
		files: mountFiles,
		objectCreationType:
			ObjectCreationType.OBJECT_CREATION_TYPE_ANONYMOUS_OWNED_BY_APP,
	});

	return resp.mountId!;
}

export async function getOrCreateImage(
	cpClient: ModalGrpcClient,
	appId: string,
	dockerfileCommands: string[] = [],
): Promise<string> {
	const resp = await cpClient.imageGetOrCreate({
		appId,
		image: { dockerfileCommands },
	});
	return resp.imageId!;
}

export async function createSecret(
	client: ModalClient,
	name: string,
	envDict: Record<string, string>,
): Promise<string> {
	const resp = await client.cpClient.secretGetOrCreate({
		deploymentName: name,
		environmentName: client.environmentName(),
		objectCreationType:
			ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_OVERWRITE_IF_EXISTS,
		envDict,
	});
	return resp.secretId!;
}

const DEFAULT_DATA_FORMATS = [
	DataFormat.DATA_FORMAT_PICKLE,
	DataFormat.DATA_FORMAT_CBOR,
];

async function createFunctionInternal(
	cpClient: ModalGrpcClient,
	appId: string,
	fn: DeployFunctionParams & { isMethod?: boolean },
) {
	const precreateResp = await cpClient.functionPrecreate({
		appId,
		functionName: fn.functionName,
		functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
		supportedInputFormats: DEFAULT_DATA_FORMATS,
		supportedOutputFormats: DEFAULT_DATA_FORMATS,
		webhookConfig: fn.webhookConfig
			? buildWebhookConfig(fn.webhookConfig)
			: undefined,
	});

	const createResp = await cpClient.functionCreate({
		appId,
		existingFunctionId: precreateResp.functionId ?? "",
		function: {
			moduleName: fn.moduleName,
			functionName: fn.functionName,
			mountIds: fn.mountIds ?? [],
			imageId: fn.imageId ?? "",
			definitionType: Function_DefinitionType.DEFINITION_TYPE_FILE,
			functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
			secretIds: fn.secretIds ?? [],
			warmPoolSize: fn.minContainers ?? 0,
			experimentalOptions: fn.experimentalOptions ?? {},
			isMethod: fn.isMethod ?? false,
			supportedInputFormats: DEFAULT_DATA_FORMATS,
			supportedOutputFormats: DEFAULT_DATA_FORMATS,
			webhookConfig: fn.webhookConfig
				? buildWebhookConfig(fn.webhookConfig)
				: undefined,
		},
	});

	return {
		functionId: createResp.functionId!,
		definitionId: createResp.handleMetadata?.definitionId,
		handleMetadata: createResp.handleMetadata,
	};
}

export async function deployApp(
	client: ModalClient,
	params: DeployAppParams,
): Promise<DeployResult> {
	const environmentName = client.environmentName(params.environment);
	const cpClient = client.cpClient;

	const appResp = await cpClient.appGetOrCreate({
		appName: params.name,
		environmentName,
		objectCreationType:
			ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
	});
	const appId = appResp.appId!;

	const functionIds: Record<string, string> = {};
	const classIds: Record<string, string> = {};
	const definitionIds: Record<string, string> = {};

	for (const fn of params.functions ?? []) {
		const result = await createFunctionInternal(cpClient, appId, fn);
		functionIds[fn.functionName] = result.functionId;
		if (result.definitionId) {
			definitionIds[result.functionId] = result.definitionId;
		}
	}

	for (const cls of params.classes ?? []) {
		const classMethods = [];

		for (const methodName of cls.methods) {
			const result = await createFunctionInternal(cpClient, appId, {
				functionName: `${cls.className}.${methodName}`,
				moduleName: cls.moduleName,
				...(cls.imageId !== undefined && { imageId: cls.imageId }),
				...(cls.mountIds !== undefined && { mountIds: cls.mountIds }),
				...(cls.secretIds !== undefined && { secretIds: cls.secretIds }),
				...(cls.minContainers !== undefined && {
					minContainers: cls.minContainers,
				}),
				...(cls.experimentalOptions !== undefined && {
					experimentalOptions: cls.experimentalOptions,
				}),
				isMethod: true,
			});

			if (result.definitionId) {
				definitionIds[result.functionId] = result.definitionId;
			}

			classMethods.push({
				functionName: methodName,
				functionId: result.functionId,
				functionHandleMetadata: result.handleMetadata,
			});
		}

		const classResp = await cpClient.classCreate({
			appId,
			methods: classMethods,
			onlyClassFunction: true,
		});

		classIds[cls.className] = classResp.classId!;
	}

	await cpClient.appPublish({
		appId,
		name: params.name,
		appState: AppState.APP_STATE_DEPLOYED,
		functionIds,
		classIds,
		definitionIds,
	});

	return { appId, functionIds, classIds };
}

function buildWebhookConfig(partial: Partial<WebhookConfig>): WebhookConfig {
	return {
		type: partial.type ?? 0,
		method: partial.method ?? "",
		requestedSuffix: partial.requestedSuffix ?? "",
		asyncMode: partial.asyncMode ?? 0,
		customDomains: partial.customDomains ?? [],
		webServerPort: partial.webServerPort ?? 0,
		webServerStartupTimeout: partial.webServerStartupTimeout ?? 0,
		webEndpointDocs: partial.webEndpointDocs ?? false,
		requiresProxyAuth: partial.requiresProxyAuth ?? false,
		ephemeralSuffix: partial.ephemeralSuffix ?? "",
	};
}

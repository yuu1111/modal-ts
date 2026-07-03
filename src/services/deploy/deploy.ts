import { createHash } from "node:crypto";
import type { ModalClient, ModalGrpcClient } from "@/core/client";
import {
	AppState,
	DataFormat,
	Function_DefinitionType,
	Function_FunctionType,
	ObjectCreationType,
	type WebhookConfig,
} from "@/generated/modal_proto/api";
import { App } from "@/services/deploy/app";
import type { LocalFunctionRuntime } from "@/services/deploy/local";
import type { Image } from "@/services/image/image";
import type { Schedule } from "@/services/schedule/schedule";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import { mergeEnvIntoSecrets, type Secret } from "@/services/secret/secret";

const textEncoder = new TextEncoder();

/**
 * @description App deployment settings
 * @property name - App name to deploy
 * @property environment - Target environment name @optional
 * @property functions - Function definitions to deploy @optional
 * @property classes - Class definitions to deploy @optional
 */
export interface DeployAppParams {
	name: string;
	environment?: string;
	functions?: DeployFunctionParams[];
	classes?: DeployClassParams[];
}

/**
 * @description Deployment settings for a single Function
 * @property functionName - Function name
 * @property moduleName - Python module path
 * @property imageId - Container image ID to use @optional
 * @property image - Container image to use @optional
 * @property mountIds - Mount IDs to attach @optional
 * @property secrets - Secrets to attach @optional
 * @property env - Values to inject as environment variables @optional
 * @property secretIds - Secret IDs to attach @optional
 * @property minContainers - Minimum number of containers in the warm pool @optional @default 0
 * @property schedule - Periodic execution schedule @optional
 * @property schedulerPlacement - Scheduling constraints @optional
 * @property experimentalOptions - Experimental options @optional
 * @property webhookConfig - Webhook endpoint settings @optional
 */
export interface DeployFunctionParams {
	functionName: string;
	moduleName?: string;
	implementationName?: string;
	localRuntime?: LocalFunctionRuntime;
	imageId?: string;
	image?: Image;
	mountIds?: string[];
	secrets?: Secret[];
	env?: Record<string, string>;
	secretIds?: string[];
	minContainers?: number;
	schedule?: Schedule;
	schedulerPlacement?: SchedulerPlacement;
	experimentalOptions?: Record<string, string>;
	webhookConfig?: Partial<WebhookConfig>;
}

/**
 * @description Class deployment settings
 * @property className - Class name
 * @property moduleName - Python module path
 * @property methods - Names of methods to expose
 * @property imageId - Container image ID to use @optional
 * @property image - Container image to use @optional
 * @property mountIds - Mount IDs to attach @optional
 * @property secrets - Secrets to attach @optional
 * @property env - Values to inject as environment variables @optional
 * @property secretIds - Secret IDs to attach @optional
 * @property minContainers - Minimum number of containers in the warm pool @optional @default 0
 * @property schedulerPlacement - Scheduling constraints @optional
 * @property experimentalOptions - Experimental options @optional
 */
export interface DeployClassParams {
	className: string;
	moduleName?: string;
	methods: string[];
	implementationName?: string;
	localRuntime?: LocalFunctionRuntime;
	imageId?: string;
	image?: Image;
	mountIds?: string[];
	secrets?: Secret[];
	env?: Record<string, string>;
	secretIds?: string[];
	minContainers?: number;
	schedulerPlacement?: SchedulerPlacement;
	experimentalOptions?: Record<string, string>;
}

/**
 * @description File entry to upload to a Mount
 * @property remotePath - File path inside the container
 * @property content - File content as text or binary data
 */
export interface MountFileEntry {
	remotePath: string;
	content: string | Uint8Array;
}

/**
 * @description Deployment result
 * @property appId - ID of the deployed app
 * @property functionIds - Mapping from Function names to IDs
 * @property classIds - Mapping from Class names to IDs
 */
export interface DeployResult {
	appId: string;
	functionIds: Record<string, string>;
	classIds: Record<string, string>;
}

/**
 * @description Returns a SHA-256 hash as a hexadecimal string
 * @param data - Binary data to hash
 * @returns Hexadecimal hash string
 */
function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * @description Creates a Mount from files and returns its ID
 * @param cpClient - gRPC client
 * @param appId - App ID to associate with the Mount
 * @param files - File entries to upload
 * @returns Mount ID
 */
export async function createMount(
	cpClient: ModalGrpcClient,
	appId: string,
	files: MountFileEntry[],
): Promise<string> {
	const mountFiles = [];

	for (const file of files) {
		const data =
			typeof file.content === "string"
				? textEncoder.encode(file.content)
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

	if (!resp.mountId) {
		throw new Error("Server returned empty mountId");
	}
	return resp.mountId;
}

/**
 * @description Gets or creates an Image
 * @param cpClient - gRPC client
 * @param appId - App ID
 * @param dockerfileCommands - Additional Dockerfile commands to run after FROM
 * @param baseImage - Base Docker image @default "python:3.12-slim"
 */
export async function getOrCreateImage(
	cpClient: ModalGrpcClient,
	appId: string,
	dockerfileCommands: string[] = [],
	baseImage = "python:3.12-slim",
): Promise<string> {
	const commands = [`FROM ${baseImage}`, ...dockerfileCommands];
	const resp = await cpClient.imageGetOrCreate({
		appId,
		image: { dockerfileCommands: commands },
	});
	if (!resp.imageId) {
		throw new Error("Server returned empty imageId");
	}
	return resp.imageId;
}

/**
 * @description Creates a Secret from environment variables and returns its ID
 * @param client - ModalClient instance
 * @param name - Secret name
 * @param envDict - Key-value mapping of environment variables
 * @returns Secret ID
 */
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
	if (!resp.secretId) {
		throw new Error("Server returned empty secretId");
	}
	return resp.secretId;
}

/**
 * @description Default serialization formats for gRPC payloads
 */
const DEFAULT_DATA_FORMATS = [
	DataFormat.DATA_FORMAT_PICKLE,
	DataFormat.DATA_FORMAT_CBOR,
];

/**
 * @description Internal function that creates a single Function through gRPC
 * @param cpClient - gRPC client
 * @param appId - App ID
 * @param fn - Function definition parameters
 * @returns functionId, definitionId, handleMetadata
 */
async function createFunctionInternal(
	cpClient: ModalGrpcClient,
	appId: string,
	fn: DeployFunctionParams & { isMethod?: boolean },
) {
	const outputFormats = fn.localRuntime
		? [DataFormat.DATA_FORMAT_CBOR]
		: DEFAULT_DATA_FORMATS;
	const precreateResp = await cpClient.functionPrecreate({
		appId,
		functionName: fn.functionName,
		functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
		supportedInputFormats: DEFAULT_DATA_FORMATS,
		supportedOutputFormats: outputFormats,
		webhookConfig: fn.webhookConfig
			? buildWebhookConfig(fn.webhookConfig)
			: undefined,
	});

	const createResp = await cpClient.functionCreate({
		appId,
		existingFunctionId: precreateResp.functionId ?? "",
		function: {
			moduleName: fn.moduleName ?? "",
			functionName: fn.functionName,
			implementationName: fn.implementationName ?? fn.functionName,
			mountIds: fn.mountIds ?? [],
			imageId: fn.imageId ?? "",
			definitionType: Function_DefinitionType.DEFINITION_TYPE_FILE,
			functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
			secretIds: fn.secretIds ?? [],
			warmPoolSize: fn.minContainers ?? 0,
			schedule: fn.schedule?.toProto(),
			schedulerPlacement: fn.schedulerPlacement?.toProto(),
			experimentalOptions: fn.experimentalOptions ?? {},
			isMethod: fn.isMethod ?? false,
			supportedInputFormats: DEFAULT_DATA_FORMATS,
			supportedOutputFormats: outputFormats,
			webhookConfig: fn.webhookConfig
				? buildWebhookConfig(fn.webhookConfig)
				: undefined,
		},
	});

	if (!createResp.functionId) {
		throw new Error("Server returned empty functionId from functionCreate");
	}
	return {
		functionId: createResp.functionId,
		definitionId: createResp.handleMetadata?.definitionId,
		handleMetadata: createResp.handleMetadata,
	};
}

/**
 * @description Gets or creates an App and returns its appId
 * @param client - ModalClient instance
 * @param name - App name
 * @param environment - Environment name @optional
 * @returns App ID
 */
export async function getOrCreateApp(
	client: ModalClient,
	name: string,
	environment?: string,
): Promise<string> {
	const resp = await client.cpClient.appGetOrCreate({
		appName: name,
		environmentName: client.environmentName(environment),
		objectCreationType:
			ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
	});
	if (!resp.appId) {
		throw new Error("Server returned empty appId from appGetOrCreate");
	}
	return resp.appId;
}

/**
 * @description Deploys an app to Modal
 * @param client - ModalClient instance
 * @param params - Deployment settings
 * @returns Deployment result with appId, functionIds, and classIds
 */
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
	if (!appResp.appId) {
		throw new Error("Server returned empty appId from appGetOrCreate");
	}
	const appId = appResp.appId;
	const app = new App(appId, params.name, environmentName);

	const functionIds: Record<string, string> = {};
	const classIds: Record<string, string> = {};
	const definitionIds: Record<string, string> = {};

	for (const fn of params.functions ?? []) {
		const functionParams = { ...fn };
		if (functionParams.localRuntime !== undefined) {
			const localMountId = await createMount(
				cpClient,
				appId,
				functionParams.localRuntime.mountFiles,
			);
			functionParams.moduleName = functionParams.localRuntime.moduleName;
			functionParams.implementationName =
				functionParams.localRuntime.implementationName;
			functionParams.mountIds = [
				...(functionParams.mountIds ?? []),
				localMountId,
			];
			if (
				functionParams.image === undefined &&
				functionParams.imageId === undefined
			) {
				functionParams.image = client.images
					.debianSlim()
					.aptInstall(["nodejs"]);
			}
		}
		if (
			functionParams.secrets !== undefined ||
			functionParams.env !== undefined
		) {
			const mergedSecrets = await mergeEnvIntoSecrets(
				client,
				functionParams.env,
				functionParams.secrets,
			);
			functionParams.secretIds = [
				...(functionParams.secretIds ?? []),
				...mergedSecrets.map((secret) => secret.secretId),
			];
		}
		if (functionParams.image !== undefined) {
			await functionParams.image.build(app);
			functionParams.imageId = functionParams.image.imageId;
			functionParams.mountIds = [
				...(functionParams.mountIds ?? []),
				...(await functionParams.image.mountIds(app)),
			];
		}
		const result = await createFunctionInternal(
			cpClient,
			appId,
			functionParams,
		);
		functionIds[fn.functionName] = result.functionId;
		if (result.definitionId) {
			definitionIds[result.functionId] = result.definitionId;
		}
	}

	for (const cls of params.classes ?? []) {
		const classParams = { ...cls };
		if (classParams.localRuntime !== undefined) {
			const localMountId = await createMount(
				cpClient,
				appId,
				classParams.localRuntime.mountFiles,
			);
			classParams.moduleName = classParams.localRuntime.moduleName;
			classParams.implementationName =
				classParams.localRuntime.implementationName;
			classParams.mountIds = [...(classParams.mountIds ?? []), localMountId];
			if (
				classParams.image === undefined &&
				classParams.imageId === undefined
			) {
				classParams.image = client.images.debianSlim().aptInstall(["nodejs"]);
			}
		}
		if (classParams.secrets !== undefined || classParams.env !== undefined) {
			const mergedSecrets = await mergeEnvIntoSecrets(
				client,
				classParams.env,
				classParams.secrets,
			);
			classParams.secretIds = [
				...(classParams.secretIds ?? []),
				...mergedSecrets.map((secret) => secret.secretId),
			];
		}
		if (classParams.image !== undefined) {
			await classParams.image.build(app);
			classParams.imageId = classParams.image.imageId;
			classParams.mountIds = [
				...(classParams.mountIds ?? []),
				...(await classParams.image.mountIds(app)),
			];
		}
		const outputFormats = classParams.localRuntime
			? [DataFormat.DATA_FORMAT_CBOR]
			: DEFAULT_DATA_FORMATS;
		const methodDefs: Record<
			string,
			{
				functionName: string;
				functionType: Function_FunctionType;
				supportedInputFormats: DataFormat[];
				supportedOutputFormats: DataFormat[];
			}
		> = {};
		for (const methodName of classParams.methods) {
			methodDefs[methodName] = {
				functionName: `${classParams.className}.${methodName}`,
				functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
				supportedInputFormats: DEFAULT_DATA_FORMATS,
				supportedOutputFormats: outputFormats,
			};
		}

		const precreateResp = await cpClient.functionPrecreate({
			appId,
			functionName: classParams.className,
			functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
			supportedInputFormats: DEFAULT_DATA_FORMATS,
			supportedOutputFormats: outputFormats,
			methodDefinitions: methodDefs,
		});

		const createResp = await cpClient.functionCreate({
			appId,
			existingFunctionId: precreateResp.functionId ?? "",
			function: {
				moduleName: classParams.moduleName ?? "",
				functionName: classParams.className,
				implementationName:
					classParams.implementationName ?? classParams.className,
				mountIds: classParams.mountIds ?? [],
				imageId: classParams.imageId ?? "",
				definitionType: Function_DefinitionType.DEFINITION_TYPE_FILE,
				functionType: Function_FunctionType.FUNCTION_TYPE_FUNCTION,
				secretIds: classParams.secretIds ?? [],
				warmPoolSize: classParams.minContainers ?? 0,
				schedulerPlacement: classParams.schedulerPlacement?.toProto(),
				experimentalOptions: classParams.experimentalOptions ?? {},
				isClass: true,
				isMethod: false,
				methodDefinitions: methodDefs,
				methodDefinitionsSet: true,
				supportedInputFormats: DEFAULT_DATA_FORMATS,
				supportedOutputFormats: outputFormats,
			},
		});

		if (!createResp.functionId) {
			throw new Error(
				`Server returned empty functionId for class '${classParams.className}'`,
			);
		}

		const fnId = createResp.functionId;
		functionIds[classParams.className] = fnId;
		if (createResp.handleMetadata?.definitionId) {
			definitionIds[fnId] = createResp.handleMetadata.definitionId;
		}

		const classResp = await cpClient.classCreate({
			appId,
			onlyClassFunction: true,
		});

		if (!classResp.classId) {
			throw new Error(
				`Server returned empty classId for class '${classParams.className}'`,
			);
		}
		classIds[classParams.className] = classResp.classId;
	}

	await cpClient.appPublish({
		appId,
		name: params.name,
		appState: AppState.APP_STATE_DEPLOYED,
		clientVersion: "1.1.3",
		functionIds,
		classIds,
		definitionIds,
	});

	return { appId, functionIds, classIds };
}

/**
 * @description Fills a partial WebhookConfig with default values
 * @param partial - Partial WebhookConfig
 * @returns Complete WebhookConfig
 */
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

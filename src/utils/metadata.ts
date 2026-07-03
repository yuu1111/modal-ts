/**
 * Common creation metadata shape used by Modal resource metadata protos.
 */
export type ResourceMetadata = {
	name?: string;
	creationInfo?:
		| {
				createdAt?: number;
				createdBy?: string;
		  }
		| undefined;
};

/**
 * Common public resource info shape.
 */
export type ResourceInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

/**
 * Converts resource metadata into the public info shape.
 *
 * @param metadata - Resource metadata from the API
 * @param fallbackName - Name to use when metadata does not include one
 * @param fallbackCreatedAt - Creation timestamp to use when metadata does not include one
 * @returns Public resource info
 */
export function resourceInfoFromMetadata<T extends ResourceInfo>(
	metadata?: ResourceMetadata,
	fallbackName?: string,
	fallbackCreatedAt?: number,
): T {
	const info: ResourceInfo = {};
	const name = metadata?.name || fallbackName;
	const createdAt = metadata?.creationInfo?.createdAt || fallbackCreatedAt;
	const createdBy = metadata?.creationInfo?.createdBy;
	if (name) info.name = name;
	if (createdAt) info.createdAt = createdAt;
	if (createdBy) info.createdBy = createdBy;
	return info as T;
}

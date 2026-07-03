import { ObjectCreationType } from "@/generated/modal_proto/api";
import { aliasedBoolean } from "@/utils/param_aliases";

/**
 * Object creation type used for unnamed ephemeral resources.
 */
export const ephemeralObjectCreationType =
	ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL;

/**
 * Resolves creation behavior for create() helpers with allowExisting aliases.
 *
 * @param params - Parameter object
 * @returns Object creation type for create APIs
 */
export function allowExistingObjectCreationType(
	params: object | undefined,
): ObjectCreationType {
	return aliasedBoolean(params, "allowExisting", "allow_existing")
		? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
		: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS;
}

/**
 * Resolves creation behavior for fromName() helpers with createIfMissing aliases.
 *
 * @param params - Parameter object
 * @returns Object creation type for lookup APIs
 */
export function createIfMissingObjectCreationType(
	params: object | undefined,
): ObjectCreationType {
	return aliasedBoolean(params, "createIfMissing", "create_if_missing")
		? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
		: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED;
}

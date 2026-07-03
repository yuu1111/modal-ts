/**
 * Throws when a renamed legacy parameter name is used
 * @param params - Parameter object to check
 * @param renames - Mapping from old names to new names
 * @throws When a legacy parameter name is used
 */
export function checkForRenamedParams(
	params: object | undefined | null,
	renames: Record<string, string>,
): void {
	if (!params) return;

	for (const [oldName, newName] of Object.entries(renames)) {
		if (oldName in params) {
			throw new Error(
				`Parameter '${oldName}' has been renamed to '${newName}'.`,
			);
		}
	}
}

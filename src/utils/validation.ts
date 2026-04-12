/**
 * @description リネームされた旧パラメータ名が使用されている場合にエラーを投げる
 * @param params - チェック対象のパラメータオブジェクト
 * @param renames - 旧名から新名へのマッピング
 * @throws 旧パラメータ名が使用されている場合
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

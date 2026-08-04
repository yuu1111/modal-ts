# modal-ts フィードバック（実地検証で遭遇した不満点と改善提案）

> MiniMax H3 × Modal の実装を `modal-ts` で進めた際に実際にぶつかった問題を整理したメモ。
> upstream（modal-labs/libmodal 相当）へのフィードバック・Issue 化を想定したもの。
> 検証日: 2026-08、modal-ts 1.0.0。

---

> 更新: 2026-08 — 項目 1〜5 は対応済み（実装・テスト・Release 反映）。

---

## 1. [最重要] Image ビルド失敗が「空例外」になり真因が分からない

> **対応済み** ✅ `src/image.ts` で `build()` のストリーミング中に `taskLogs[].data` を収集し、`onLog` コールバックで露出。失敗時はサーバー異常が空でも `ImageBuildError` に末尾ログ（既定80行）を付与する。<br>
> 公開 API: `ImageBuildOptions` / `ImageBuildError`（`logs` プロパティ） / `buildFailureMessage`。

### 事象

`Image.build()` が失敗したとき、

```
Image build for im-... failed with the exception:

```
という**空メッセージ**だけが飛んでくる。

`dist/index.js` の実装:

```js
if (result.status === 2 /* GENERIC_STATUS_FAILURE */) {
  throw new Error(
    `Image build for ${resp.imageId} failed with the exception:\n${result.exception}`
  );
}
```

サーバーは `result.exception` を空で返すため、エラーメッセージが空になる。

### 真のログは捨てられている

`cpClient.imageJoinStreaming({ imageId, timeout, lastEntryId, includeLogsForFinished: true })`
でストリーミングすると `item.taskLogs[].data` に**完全なビルド出力**（例: `pip: not found`）が流れる。
しかし modal-ts の公開 API はこれを一切露出しない。

### 改善提案

- `Image.build()` に `onLog` 系コールバックを追加（ストリーミング中に `taskLogs` を流す）
- または失敗時の例外に **stderr / stdout の末尾 N 行** を含める
- 最低限、`result.exception` が空でも「ログは raw streaming で取れる」という案内を出す

---

## 2. ビルダー版のデフォルトと環境の不整合

> **対応済み** ✅ `ModalClient.resolveImageBuilderVersion()`（`Image.build()` 内で自動使用）が「明示指定 > プロファイル/環境変数 > **環境の実値** > 既定値」の順で解決する。環境の実値は `EnvironmentGetOrCreate` で取得し、環境ごとにキャッシュ。設定値（既定 `2024.10`）と環境の実値（例 `2025.06`）がズレていれば警告ログを出す。

### 事象

- 既定 `client.imageBuilderVersion()` が **`2024.10`** を返す
- 環境（main）の `imageBuilderVersion` は **`2025.06`**

```ts
const env = await modal.environments.fromName("main", { createIfMissing: false });
env.imageBuilderVersion // => "2025.06"
```

今回の失敗の直接原因ではなかったが、「何が悪いか」の切り分け時に**最初に疑うべきズレ**。
モジュール側が環境の値を見て自動フォールバックしてくれない。

### 改善提案

- 既定バージョンは環境の実際の値と同期する / `getImageBuilderVersion()` を自動で使う
- 不整合時は警告を出す

---

## 3. exports map が `.` のみで内部モジュールに触れない

> **対応済み** ✅ `package.json` の `exports` に `"./internal"` を追加し、`src/internal.ts` から generated / proto を公開（`Image` の `MessageFns` や生 RPC へのアクセスが可能に）。

### 事象

- `package.json` の `exports` は `"."` だけ
- proto の `Image`（`MessageFns`、`.create` を持つ方）や generated モジュールを import できない
- ビルドログ取得の道具を作る際に、raw RPC を叩くために生ファイルを参照する必要があり寄り道した

### 改善提案

- `"modal-ts/internal"` 等の `@internal` サブパスを exports で公開（明示的に不安定と明記）

---

## 4. 生成コードが読めず、裏 RPC の公式化がない

> **対応済み** ✅ `imageJoinStreaming` の「ビルド実行 + ログ取得」は `Image.build(app, { onLog })` として API 化。**完了済みビルドの過去ログ取得**は `client.images.fetchLogs(imageId)`（`ImageLogsOptions` で `onLog` / `timeout` 指定可、`Image.fetchLogs` 静的互換もあり）として API 化し、`ImageBuildError` が `imageId` を保持して失敗後のログ再取得に対応。raw の生成 proto（`ModalClientDefinition` 等）は `modal-ts/internal` サブパスで公開。最小 gRPC インターフェースのドキュメント化のみ未対応。

### 事象

- `dist/index.js` は protobuf 生成＋バンドルのため、仕様の把握に読解が要る（`build()` のレイヤ処理、`imageGetOrCreate` / `imageJoinStreaming` の接続が自明でない）
- 有用な RPC 流（`imageGetOrCreate` → `imageJoinStreaming`）が **API 化されておらず raw で叩くしかない**

### 改善提案

- `Image` レベルで「ビルド実行 + ログ取得」をカプセル化した API を提供
- 裏で使っている gRPC の最小インターフェースをドキュメント化する

---

## 5. 参考: `runCommands` の配列セマンティクス（バグではない）

> **対応済み** ✅ `Image.runCommands(commands)` を追加し、各要素が独立した `RUN <コマンド>` になることを明示。docstring で「引数を複数要素に分割しない（`["bash", "-c", "cmd"]` は避けて `["bash -lc cmd"]` のように渡す）」と注意書き。`dockerfileCommands` 側も配列要素が生の Dockerfile 行である旨を明記。

`runCommands(["bash", "-c", "cmd"])` は**配列要素ごとに独立した RUN 行**になる
（`RUN bash` / `RUN -c` と分解され `-c requires an argument` で失敗）。

- 実装は `commands.map((c) => \`RUN ${c}\`)` なので仕様どおり
- **文字列 1 本で渡せば正しく動く**（`BUILD_COMMANDS` はこれに該当）
- 罠になりやすいので、docstring で明示するか、`shell -c` を推奨する形があると親切

---

## 6. 良かった点（公平な補足）

- 認証 → Sandbox 起動 → stdout/stderr ストリーム回収 → Volume まで、**TS だけで完結**できた
- `SandboxCreateParams.memoryMiB / memoryLimitMiB` など、リソース指定の粒度は揃っている
- `cpClient` が `readonly` で公開されており（たまたま）裏 API に触れたことで復旧できた
- 「ローカルは TS のみ」という方針は成立すると実感

---

## 7. まとめ（upstream に出すなら）

優先順:

1. ~~**Image ビルド失敗時のログ/エラー詳細の伝播**（空例外の解消）~~ → **対応済み**（`ImageBuildError` + 末尾ログ）
2. ~~**`imageJoinStreaming` の API 化**（ビルドログ取得）~~ → **対応済み**（`Image.build(app, { onLog })`）
3. ~~ビルダー版のデフォルトと環境の同期~~ → **対応済み**（`resolveImageBuilderVersion()` で環境の実値へ自動フォールバック + 不整合警告）
4. ~~`@internal` サブパス exports の公開~~ → **対応済み**（`modal-ts/internal`、`src/internal.ts` で公開）
5. ~~`runCommands` の配列挙動のドキュメント化~~ → **対応済み**（`Image.runCommands()` 追加 + docstring 明記）
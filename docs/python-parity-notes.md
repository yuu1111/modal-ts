# Python SDK パリティメモ

このメモは、local deploy / `from_local` 対応後に残った Python SDK との
パリティ判断を追跡するためのもの。

## 追加済みの互換 surface

- `Function_.from_local()` / `Function_.fromLocal()` と `Cls.from_local()` /
  `Cls.fromLocal()` は、deploy 可能なローカル JavaScript/TypeScript runtime
  を作成できる。
- local deploy は inline handler、file entrypoint、`sourceDir`、TypeScript
  transpile、esbuild による opt-in の `bundle: true` をサポートしている。
- default client へ安全に委譲できる resource handle には、Python 風の static
  helper を追加した:
  - `Image.from_id`, `Image.from_name`, `Image.from_registry`,
    `Image.from_scratch`, `Image.debian_slim`, `Image.from_dockerfile`,
    `Image.from_aws_ecr`, `Image.from_gcp_artifact_registry`, `Image.micromamba`
  - `Sandbox.create`, `Sandbox.from_id`, `Sandbox.from_name`, `Sandbox.list`
  - `Queue.ephemeral`, `Dict.ephemeral`, `Volume.ephemeral`, `Volume.rename`
  - `Queue.create/list/delete`, `Dict.create/list/delete`,
    `Volume.create/list/delete`
  - `NetworkFileSystem.ephemeral`, `NetworkFileSystem.create_deployed`,
    `NetworkFileSystem.delete`
  - `Image.delete`
  - `Proxy.fromName`
  - `Secret.from_object` / `Secret.fromObject`
  - `Secret.create/list/delete`, `Secret.update`
  - `Environment.create/list/delete`
  - `SidecarContainer.name`, `SidecarContainer.object_id`
- Workspace settings には破壊的変更を避けた manager を追加した:
  - `workspace.settings()` は既存 method のまま維持する。
  - `workspace.settingsManager.list()/set()/validSettings()` and
    `workspace.settings_manager` が Python の manager 風操作を提供する。
    既存の `settings()` method を property に変えることはしない。
- snake_case だけが存在していた Python 風 handle method には CamelCase alias
  を追加した。これにより exported SDK surface は TypeScript-native な綴りと
  Python 互換の綴りを両方持つ。

## 意図的にまだ追加していないもの

- `Function.app`
  - Python は function handle が app context を保持しているためこれを公開できる。
  - TypeScript の `Function_` handle は現状、function identity と handle metadata
    は保持しているが、信頼できる `App` handle は保持していない。
  - placeholder を足すと誤解を招く。正しく実装するには
    deploy/fromName/hydration 経路で app context を運ぶ必要がある。

- callable な `Cls(...)`
  - Python は `Cls` object を callable にして instance object を返せる。
  - TypeScript では現在 `cls.instance(...)` を呼ぶ形になっている。
  - 直接呼び出し構文を再現するには、通常の class instance ではなく
    Proxy/function-backed object を返す必要があり、API 設計として大きめの変更になる。

- `VolumeBatchUpload.resolve`
  - Python の async context manager 実装に結びついている。
  - TypeScript の upload helper は形が異なるため、`resolve()` を直接公開しても
    既存 public API にきれいには対応しない。

## 現時点の推奨

残りの項目は、破壊的変更または構造的な API 変更を正当化する具体的な use case が
出るまでは intentional non-parity として維持する。名前だけの互換 shim よりも、
型が効く TypeScript-native な affordance を優先する。

## 最新の監査結果

現在の監査では以下を確認する:

- Python `modal.__all__` vs `src/index.ts`
- upstream `modal-client/js/src/index.ts` vs `src/index.ts`
- 選定した Python public class member vs TypeScript class member
- TypeScript-native な camelCase alias を持たない snake_case method
- 対応する handle static helper がない local service manager helper
- upstream JS の control-plane RPC 使用状況 vs local の control-plane RPC 使用状況

実行方法:

```bash
bun run audit:parity
```

この監査後に残る既知の intentional non-parity:

- `Function.app`
- callable な `Cls(...)`
- `VolumeBatchUpload.resolve`

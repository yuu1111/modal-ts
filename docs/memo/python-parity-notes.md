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
  - `App.from_name` / `App.fromName`, `App.environmentName`
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
  - `CloudBucketMount.create`, `CloudBucketMount.forcePathStyle`,
    `CloudBucketMount.force_path_style`, Python 風の snake_case params
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
- `ModalClient.getImageBuilderVersion()` を追加した。profile の
  `imageBuilderVersion` を優先し、未指定時は Environment metadata から取得する。
- `ModalClient.from_env()` / `fromEnv()`、`ModalClient.from_credentials()` /
  `fromCredentials()`、`ModalClient.is_closed()` / `isClosed()` を追加した。
- `FilePatternMatcher.from_file()`、`can_prune_directories()`、
  `Tunnel.unencrypted_host` / `unencrypted_port`、`ContainerProcess.poll()` /
  `returncode` を追加した。
- Python 側で snake_case になっている代表的な parameter alias も追加した。
  `environment_name`、`create_if_missing`、`allow_existing`、`allow_missing`、
  `max_objects`、`created_before`、`required_keys`、Image build 系の
  `force_build` / `context_files` / `build_args` / `python_version` /
  `find_links` / `extra_index_url` / `uv_version`、Queue の `partition_ttl` /
  `item_poll_timeout`、Volume mount の `read_only` / `sub_path`、
  Function/Cls/Server autoscaler 系の `min_containers` / `max_containers` /
  `buffer_containers` / `scaledown_window` / `target_inputs` / `wait_ms`、
  Sandbox create 系の `network_file_systems` / `block_network` /
  `outbound_cidr_allowlist` / `encrypted_ports` / `readiness_probe`、
  Dict の `skip_if_exists`、Sandbox/Sidecar wait の `raise_on_termination`、
  FunctionCall cancel の `terminate_containers` などを受け付ける。
- Python SDK の `modal.billing` 相当は `src/billing.ts` と `src/index.ts` で
  `billing`、`workspace_billing_report` / `workspaceBillingReport`、
  `BillingReportItem`、`WorkspaceBillingReportItem` を export 済み。

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

- Python `App` の registry/decorator API
  - Python の `App` は `app.function()`、`app.cls()`、`app.local_entrypoint()`、
    `app.include()` で local object registry を組み立て、`app.deploy()`、
    `app.run()`、`app.serve()` まで持つ。
  - TypeScript 側は現在 `Function_.fromLocal()` / `Cls.fromLocal()` と
    `deployApp(client, { functions, classes })` で deploy できるが、`App`
    instance 自体は deploy 済み app handle 寄りで、local registry を保持しない。
  - ここを Python と同じ形にするには、`App` を builder/handle の二役にするか、
    別の builder object を導入する必要がある。Deploy まで含めるなら次に設計すべき
    最大の残差。

- `VolumeBatchUpload.resolve`
  - Python の async context manager 実装に結びついている。
  - TypeScript の upload helper は形が異なるため、`resolve()` を直接公開しても
    既存 public API にきれいには対応しない。

- `Function.with_options(..., routing_region=...)` /
  `Cls.with_options(..., routing_region=...)`
  - TypeScript 側の runtime override は現在 `FunctionOptions` proto へ直接変換している。
  - Python の `routing_region` を安全に反映するには、TS 側で routing/placement の
    対応先を設計してから入れる必要がある。
  - 名前だけ受けて無視する shim は SDK として嘘になるため、現時点では
    intentional gap として扱う。

## 現時点の推奨

残りの項目は、破壊的変更または構造的な API 変更を正当化する具体的な use case が
出るまでは intentional non-parity として維持する。名前だけの互換 shim よりも、
型が効く TypeScript-native な affordance を優先する。

## 最新の監査結果

現在の監査では以下を確認する:

- Python `modal.__all__` vs `src/index.ts`
- upstream `modal-client/js/src/index.ts` vs `src/index.ts`
- upstream JS の exported class public member vs local class member
- 選定した Python public class member vs TypeScript class member
- 選定した Python dataclass field vs TypeScript class member
- TypeScript-native な camelCase alias を持たない snake_case method
- 対応する handle static helper がない local service manager helper
- upstream JS の control-plane RPC 使用状況 vs local の control-plane RPC 使用状況
- Python 由来の代表的な snake_case parameter alias が local source に存在するか
- intentional structural gap の一覧

実行方法:

```bash
bun run audit:parity
```

この監査後に残る既知の intentional non-parity:

- `Function.app`
- callable な `Cls(...)`
- `VolumeBatchUpload.resolve`
- `Function/Cls.with_options(... routing_region ...)`

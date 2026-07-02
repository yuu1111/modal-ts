# modal-ts

[English](./README.md)

TypeScript/JavaScript向けの非公式Modal SDK。
PythonランタイムなしでJS/TSプロジェクトからModalを利用できます。

[modal-labs/modal-client](https://github.com/modal-labs/modal-client) (Apache-2.0)
のJavaScript/TypeScript SDKをベースにしています。

## modal-tsを使う理由

`modal-ts` は、アプリのセットアップにPythonランタイムを持ち込みたくない
JavaScript/TypeScriptプロジェクト向けにModalをパッケージします。

- **Python不要** - PythonなしでNode.jsからインストール・実行
- **TypeScript-first** - Modalリソース、パラメータ、レスポンスに強い型を提供
- **主要リソース対応** - Functions、Sandboxes、Queues、Volumes、Images、
  Secrets、Deployを1つのクライアントから扱える

## インストール

```bash
npm install modal-ts
```

## 認証

環境変数を設定するか `~/.modal.toml` を構成:

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
```

## クイックスタート

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

// デプロイ済みの関数を呼び出す
const echo = await modal.functions.fromName("my-app", "echo");
const result = await echo.remote(["Hello world!"]);
console.log(result);

// サンドボックスを実行する
const app = await modal.apps.fromName("my-app", { createIfMissing: true });
const image = modal.images.fromRegistry("alpine:3.21");
const sb = await modal.sandboxes.create(app, image, { command: ["echo", "hi"] });
console.log(await sb.stdout.readText());
await sb.terminate();
```

## 機能

- **Functions** - デプロイ済みのModal関数やクラスの呼び出し
- **Sandboxes** - サンドボックスの作成・管理(exec、stdin/stdout、トンネル、ファイルシステムアクセス)
- **Queues** - パーティション対応の分散FIFOキュー
- **Volumes** - 永続ストレージ
- **Images** - レジストリ、Dockerfile、ECR、GCP Artifact Registryからのコンテナイメージビルド
- **Secrets** - 環境シークレットの管理
- **Deploy** - gRPC APIを通じたアプリ・関数・クラスのデプロイ

## 開発

```bash
bun install           # 依存インストール + proto生成
bun run typecheck     # 型チェック
bun run lint          # Biome lint
bun run format        # Biome format
bun run build         # ビルド (esbuild + tsc)
bun run test          # テスト実行 (vitest)
```

一部のImage統合テストはプライベートなAWS/GCPレジストリ用Secretを必要とします。
Secretがない環境では `MODAL_TS_SKIP_CLOUD_REGISTRY_TESTS=1` を設定すると、
そのレジストリ固有テストをオプトアウトできます。Proxy統合テストも事前作成済みの
`modal-ts-test-proxy` fixtureを必要とするため、利用できない環境では
`MODAL_TS_SKIP_PROXY_TESTS=1` でオプトアウトできます。

## ライセンス

Apache-2.0

Protocol Buffer定義は、Apache-2.0ライセンスの
[modal-labs/modal-client](https://github.com/modal-labs/modal-client)
に含まれる `modal_proto/` をベースにしています。

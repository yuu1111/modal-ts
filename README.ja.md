# modal-ts

[English](./README.md)

TypeScript/JavaScript向けの非公式Modal SDK。[modal-labs/libmodal](https://github.com/modal-labs/libmodal) (Apache-2.0) からフォーク。

## インストール

```bash
npm install modal
# or
bun add modal
```

## クイックスタート

```typescript
import { ModalClient } from "modal";

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

## 認証

環境変数を設定するか `~/.modal.toml` を構成:

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
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
bun test              # テスト実行
```

## upstreamとの違い

このフォークは `modal-labs/libmodal` から以下の点で分岐:

- **TypeScriptのみ** - Go SDKを削除
- **Python依存なし** - テストインフラとリリーススクリプトをTypeScriptで書き直し
- **Bun** - npmの代わりにBunを使用
- **Biome** - ESLint + Prettierの代わりにBiomeを使用
- **厳格なTypeScript** - `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`を有効化。`any`と`@ts-`ディレクティブなし
- **esbuild** - tsupの代わりにesbuildを直接使用
- **サブモジュールなし** - Proto定義を直接コミット

## ライセンス

Apache-2.0。Proto定義は [modal-labs/modal-client](https://github.com/modal-labs/modal-client) (Apache-2.0) から取得。

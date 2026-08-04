# modal-ts フィードバック追加（1〜5 以外の軽微な所見）

> `docs/modal-ts-feedback.md`（1〜5）に未完の、実地で気になった軽度〜中程度の所見。
> 検証日: 2026-08、modal-ts 1.0.0。

---

## 6. `Image` の名前衝突（class vs proto メッセージ）

- `Image`（ビルド commands を組み立てる **class**）と proto の `Image`（`.create` を持つ **message**）が**同名**
- export されて動くのは class の方のみ → proto 側を import するとき名前解決が混乱する
- ログ取得工具で `.create()` を持つ方へ振り向ける際に寄り道した

> **対応済み** ✅ `modal-ts/internal` で proto メッセージを **`ImageMessage`** として別名 export（`Image as ImageMessage`）。class `Image` の docstring にも「proto メッセージは `ImageMessage` で得られる」旨を追記。`Image` はそのままも利用可。

## 7. 公開される日本語 docstring に文字化け

- 生成 `.d.ts` のコメントに `イメージビルダーのバ�Eジョン` のような mojibake（`サ�Eバー` 等）
- 実害は小さく、最初は **published な生成物が壊れて上がっている**ように見えた

> **検証済み・実害なし** ✅ ローカル `dist/*.d.ts` と公開済み npm tarball（`modal-ts@1.0.0`）内の `.d.ts` を実ファイルでバイト検証したところ正常な UTF-8 だった（例: `イメージビルダーのバージョンを返す`）。置換文字 U+FFFD は 0 件、ソース `src/*.ts` と生成物の中身も一致。
> 観測された `バ�Eジョン` は**ターミナル／エディタ側の文字コード（コードページ）表示の問題**。UTF-8 対応表示（例: `chcp 65001`）で開けば自然に直る。コードの修正は不要。

## 8. `fromRegistry` が「非キャッシュ時はビルド/取り込みが走る」のが非自明

- キャッシュ済みなら素通り（`phase0` はこれで動いた）
- 未キャッシュのイメージは**暗黙に取り込みビルド**が走り、失敗時はメイン doc §1 の空例外になる
- 「直接参照だけのはずがビルドが発生し、重い/失敗する」原因として気付きにくい

> **対応済み** ✅ `fromRegistry` / `Image#build` の docstring に「遅延参照。使用時（`build()` や `Sandbox.create()`）に未キャッシュタグの取り込み・ビルドが走る」ことを明記。ビルド起点では未キャッシュベースイメージの取り込みを意味するデバッグログも追加。失敗は空例外でなく `ImageBuildError`（末尾ログ付き）+ `onLog` で観測可能。

## 9. snake_case / camelCase の二重エイリアスが目立つ

- Python 互換の `from_name`/`fromId`、`snapshot_filesystem`/`snapshotFilesystem` 等が多数
- 取り合わせの狙いは理解できるが **公開表面積が倍**になる
- TS 用途では camelCase だけで十分に思える

> **検証済み・削除対象なし** ✅ modal-ts の `src`（generated 除外）を横断検索したが、snake_case のメソッド定義は 0 件。公開 API は既に camelCase のみ（`fromId` / `snapshotFilesystem` / `fromName` / `runCommands` 等）。`token_id` / `server_url` 等の下線は設定キー・環境変数・文字列リテラル内のみで、メソッドエイリアスではない。→ 対応不要（方針は「camelCase のみ」で確定済み）。

## 10. 束ねられた生成物が重い

- `dist/index.js` が単一で 68k 行超・多量 proto。type surface が広く treeshake しづらい
- ランタイムは問題なしだが、**ビルド / 型チェック / IDE が重い**印象
- メイン doc §3（`@internal` exports 分割）と同時にモジュール化すると良さそう

---

## まとめ

本質的な欠陥というより **「軽微・仕様上の癖」**。
upstream への priority は 1〜5 を中心に据え、6〜10 は付帯改善として提案するのが妥当。
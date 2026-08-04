# modal-ts フィードバック追加（1〜5 以外の軽微な所見）

> `docs/modal-ts-feedback.md`（1〜5）に未完の、実地で気になった軽度〜中程度の所見。
> 検証日: 2026-08、modal-ts 1.0.0。

---

## 6. `Image` の名前衝突（class vs proto メッセージ）

- `Image`（ビルド commands を組み立てる **class**）と proto の `Image`（`.create` を持つ **message**）が**同名**
- export されて動くのは class の方のみ → proto 側を import するとき名前解決が混乱する
- ログ取得工具で `.create()` を持つ方へ振り向ける際に寄り道した

改善: `ImageMessage` 等へ改名 / proto 側の別名 export。

## 7. 公開される日本語 docstring に文字化け

- 生成 `.d.ts` のコメントに `イメージビルダーのバ�Eジョン` のような mojibake（`サ�Eバー` 等）
- 実害は小さいが **published な生成物が壊れて上がっている**ことを感じさせる品質感染

改善: docstring 生成工程の文字コード処理を確認。

## 8. `fromRegistry` が「非キャッシュ時はビルド/取り込みが走る」のが非自明

- キャッシュ済みなら素通り（`phase0` はこれで動いた）
- 未キャッシュのイメージは**暗黙に取り込みビルド**が走り、失敗時はメイン doc §1 の空例外になる
- 「直接参照だけのはずがビルドが発生し、重い/失敗する」原因として気付きにくい

改善: API 表面で「register 時にビルドが走り得る」ことを文書化 / ログで明示。

## 9. snake_case / camelCase の二重エイリアスが目立つ

- Python 互換の `from_name`/`fromId`、`snapshot_filesystem`/`snapshotFilesystem` 等が多数
- 取り合わせの狙いは理解できるが **公開表面積が倍**になる
- TS 用途では camelCase だけで十分に思える

改善: 削除は求めないが、doc で主従を明示してほしい。

## 10. 束ねられた生成物が重い

- `dist/index.js` が単一で 68k 行超・多量 proto。type surface が広く treeshake しづらい
- ランタイムは問題なしだが、**ビルド / 型チェック / IDE が重い**印象
- メイン doc §3（`@internal` exports 分割）と同時にモジュール化すると良さそう

---

## まとめ

本質的な欠陥というより **「軽微・仕様上の癖」**。
upstream への priority は 1〜5 を中心に据え、6〜10 は付帯改善として提案するのが妥当。
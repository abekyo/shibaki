# One-Loop Contract

Shibaki とユーザーの間の契約。**この契約を破る機能は追加しない**。

---

## ユーザーが渡すもの (3つだけ)

1. `--agent <cmd>` — 実作業を行う外部エージェントコマンド (例: `claude -p`)
2. `--verify <cmd>` — 完遂判定コマンド。exit 0 で成功とみなす
3. タスク本文 (自然言語)

**これ以上の設定はユーザーに書かせない**。tone / personality / critic log level
等の設定項目は永久に追加しない (Anti-Vision §3)。

## Shibaki が返すもの

- 成果物 (ファイル変更 diff)
- 完遂 / 失敗の 1 行ステータス
- **各試行ごと**: critic の verdict + reason + (refuted 時) attack angles、
  counter-example、evidence、insight を stderr に出力
- **完遂時**: `✓ done` と cost サマリで loop 終了

critic の反論は **意図的に表示する**。以前は「ミニマリズム」を掲げて隠して
いたが、それだと user は「critic が本当に役に立ったか」「誤爆による無駄 retry
ではないか」を判断できない。透明性をミニマリズムより優先する。

内部に留めるもの: 失敗モード辞書 (session 開始時にロード、終了時に永続化) と
JSONL debug log (`--debug` 時のみ書き出し)。

## 待ち時間の UX

- 各試行で in-place ticker を表示: `↳ agent (N秒)` と `↳ critic (N秒)`、
  rebuttal 完了後に critic の verdict ブロックが続く
- 長時間タスク: `--detach` で背景実行 + 完了時通知 (将来検討)

## 完遂条件

- `--verify` の exit code が 0
- かつ rebuttal critic が `unable_to_refute` を返す

## 失敗時の返し方

MAX 試行超 or 予算超過:

```
✗ 完遂失敗 (10 回試行、12 分)
  ハマりパターン: <pattern_name>
  推奨: 手動確認してください
```

失敗理由は各試行の critic ブロックで既に見えている。この 1 行はあくまで
「どの予算で打ち切ったか」の要約。loop 内で user に「読ませる/反応させる」
体験は作らない (読むのは loop 終了後)。

## 受理しないタスク

`--verify` が指定されていない、または Tier 3 (主観判定) の場合:

```
✗ Shibaki はこのタスクを受理できません
  理由: 完遂判定コマンド (--verify) がありません
  代替: 素の `claude -p` を直接使ってください
```

詳細は [scope.md](./scope.md)。

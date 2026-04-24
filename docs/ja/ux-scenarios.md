# UX シナリオ (紙芝居)

実装前にユーザー体験を秒単位で書き起こし、**North Star と Anti-Vision に
抵触する "気持ち悪さ"** を潰すための文書。

コードを書く前にこの4本を読み返し、想定通りの体験になっているか検算する。

---

## シナリオ A: failing test を直す (基本形)

```
[00:00] ユーザー入力
$ shibaki run \
    --agent "claude -p" \
    --verify "bun test tests/auth.test.ts" \
    "tests/auth.test.ts の failing test を直して"

[00:02] Shibaki
▶ タスク受理 (verify: bun test tests/auth.test.ts)
▶ 試行 1/10

[00:45] Shibaki
▶ 試行 2/10

[01:30] Shibaki
▶ 試行 3/10

[02:50] Shibaki
✓ 完遂 (2 分 50 秒 / 3 回試行)
  変更: src/auth.ts (+12 -3), tests/auth.test.ts (+2)
```

**内部で起きていること (ユーザーには見せない)**:
- 試行 1: agent "完了" → verify 落ちる → rebuttal "AssertionError line 42" → 再試行
- 試行 2: agent "完了" → verify 通る → rebuttal "null 入力で落ちる" → 再試行
- 試行 3: agent "完了" → verify 通る → rebuttal "反例なし" → 完遂

**検算**:
- ✅ 人間はループに入っていない (原則1)
- ✅ critic が別プロバイダ (原則2)
- ✅ rebuttal は反例付き (原則3)
- ✅ 進捗 ticker + 各試行ごとに critic の verdict ブロックを表示

---

## シナリオ B: 型エラーを消す

```
[00:00] $ shibaki run --agent "claude -p" --verify "tsc --noEmit" "型エラー全部消して"
[00:02] ▶ タスク受理
[00:02] ▶ 試行 1/10
[01:40] ▶ 試行 2/10
[03:10] ✓ 完遂 (3 分 10 秒 / 2 回試行)
```

**想定される critic の詰め**:
- agent が `as any` / `@ts-ignore` で潰した箇所を rebuttal が列挙
- "この型は実質 any で、実行時に落ちる入力: `{foo: null}`" → 反例
- 再試行で真面目に型付けさせる

**穴**: `@ts-ignore` を検出するには rebuttal に diff を渡す必要あり
→ 実装: agent 実行後の git diff を rebuttal の入力に含める

---

## シナリオ C: リファクタ (Tier 2 → 受理拒否)

```
[00:00] $ shibaki run --agent "claude -p" --verify "bun test" "authService をクラスから関数に"
[00:01] ✗ 完遂失敗: リファクタタスクは現状受理しません
  理由: 既存テスト全通過だけでは挙動不変が担保できない (mock で隠れる可能性)
  代替: 素の `claude -p` を直接使ってください
```

**現状の Tier 1 範囲では即断る**。受け入れ基準を `--accept` で取れる Tier 2 は将来検討。

---

## シナリオ D: 諦める時

```
[00:00] $ shibaki run --agent "claude -p" --verify "bun test" "この難しいテストを直して"
[00:02] ▶ 試行 1/10
...
[12:40] ▶ 試行 10/10
[13:15] ✗ 完遂失敗 (10 回試行 / 13 分)
  ハマりパターン: silent_mock_bypass
  推奨: テスト実行ログを手動確認してください
```

**返すのは 1 行の pattern_name のみ**。critic ログは表示しない。
ユーザーは「ああ、mock で誤魔化そうとしてたのか」だけ分かれば十分。

---

## シナリオ E: `--verify` 未指定で受理拒否

```
[00:00] $ shibaki run --agent "claude -p" "なんかいい感じにリファクタして"
[00:01] ✗ Shibaki はこのタスクを受理できません
  理由: --verify が指定されていません (完遂判定できない)
  代替: 素の `claude -p` を直接使ってください
```

**Shibaki は曖昧タスクを断る**。これが North Star を守る最後の砦。

---
## 検算チェックリスト (コードを書く前に全項目 ✅ にする)

- [ ] ユーザーが投入後にキーボードを触らずに済むか
- [ ] 進捗表示が 1 行を超えていないか
- [ ] critic ログがどこにも漏れ出していないか
- [ ] 失敗時の返却が pattern_name だけで完結するか
- [ ] 受理拒否の文言が「素のエージェントを使え」と明示するか
- [ ] help 先頭の Before/After だけで使う / 使わないが 30 秒で判断できるか

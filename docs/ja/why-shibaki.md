# Why Shibaki

LLM 全盛時代に欠けているレイヤを言語化する文書。

本文書の論考は **私が AI と数週間実戦してきた 30 手の critic pattern**
([docs/critic-patterns.md](./critic-patterns.md)) に裏付けられています。各観察に
実例を引用しているので、抽象論ではなく具体記録として読めます。

---

## 観察 1: AI は process 中毒に陥る

LLM agent (Claude Code / Cursor / Devin / Copilot) に「failing test を直して」と頼むと、
こんなことが頻発する:

```
タスク: tests/auth.test.ts の failing test を 1 つ直して
agent の振る舞い:
  ✓ failing test を直した
  + ついでに auth.ts の他関数も refactor した
  + ついでに防御的 input validation を 3 ファイルに追加した
  + ついでに新しい AuthHelper class を作った
  + ついでに JSDoc を全関数に追加した
  + ついでに TypeScript の型を more strict に書き直した
返ってきた diff: 47 ファイル / 1200 行変更
```

これは **「ズル」ではない**。バグでもない。コードレビューも通る。テストも通る。
だが **ユーザーが頼んだものではない**。

LLM は process に没頭しやすい性質を持っている:
- 「もっと良くしたい」 → over-engineering
- 「念のため defensive に」 → 不要な edge case 防御
- 「関連するし...」 → scope 拡大
- 「ちゃんとした structure に」 → 勝手な refactor

この振る舞いを **「process 中毒」** と呼ぶ。

実例 (実戦で出てきた発言、原文ママ):

> 全部の記事に「今日はここまで」っていう締めのメッセージが入っているはずなのに
> 勝手に消しちゃってない？

> なんか備考とか勝手に加えらえててこれによってコピペして入稿できないんだけど

「指示してない箇所を AI が触った」典型例。テストは通る。コードは正しい。
**だが頼んでない**。([critic-patterns.md 手 4](./critic-patterns.md#手-4-勝手にやった告発))

## 観察 2: 既存ツールはこれを catch できない

| ツール | 検出範囲 | process 中毒は? |
|---|---|---|
| Linter (eslint, ruff) | コードスタイル | ❌ 検出不可 |
| Test runner | コード正しさ | ❌ 「ついで」が増えても test は通る |
| Code review (Codium / Copilot Review) | コード品質 | ❌ 「良くなった」と肯定する |
| Type checker | 型整合 | ❌ over-engineering を検出しない |
| Claude Code 内蔵の self-review | agent 自身の判断 | ❌ self-critique bias、process に没頭する agent が自分を止めない |

これらは **コードレベルの正しさ** を見るが、**「ユーザーが頼んだ範囲か」** を見ない。

## 観察 3: AI 同士の批評だけでは解決しない

「critic AI を別に走らせれば agent を止められる」と思いがちだが、構造的に難しい:

- critic は agent の **subset 情報** しか持たない (diff + verify 結果のみ)
- agent は full file system / 多ターン思考 / 検索能力を持つ
- **より少ない情報で別視点を出せ** は不可能に近い
- 結果: critic は agent の判断を覆せず、または幻覚 attack に走る

実際 Shibaki も初期実装でこれを実証してしまった。
critic を強化すればするほど **既存ツールの寄せ集め** になり、価値が出なかった。

実戦の言葉で言うと:

> Sibakiによっていい効果がうまれているのか？
> Claude単体で十分なのか

これは shibaki 実装が走り終わった直後の私自身の問い。Claude 単体と差が出ないと
プロダクトの存在意義が崩れる。([critic-patterns.md 手 8](./critic-patterns.md#手-8-claude-単体との-ab-要求))

## 観察 4: 人間が 30 秒だけ介入すれば全部解決する

ところが、**人間が「あれ、それは頼んでない」と 30 秒で言える** なら、agent は即座に軌道修正できる。

```
agent: 「failing test を直して、ついでに refactor もしました」
human: 「refactor は要らない、失敗テストだけで」
agent: 「了解、refactor を元に戻して再 commit」
```

このパターンは:
- **コードレビューより遥かに速い** (60 秒 vs 30 分)
- **agent の self-review より遥かに正確** (人間は本当の目的を知ってる)
- **human を loop に入れない原則を守れる** (1 回 30 秒、コード詳細は見ない)

Shibaki はこの **「人間 30 秒で agent が完遂」** パターンを実装したツールです。

実戦における代表的な引き戻し (drift correction):

> 目的は "しばく" じゃなくて "最後まで走り切らせる" で、詰問は気づきを与える手段

これは shibaki という製品名そのものに対する自己 meta 補正でもあった。
"しばく" を目的化していたら process 中毒に陥る側だった。
([critic-patterns.md 手 30](./critic-patterns.md#手-30-最後まで走り切らせるへの常時回帰))

## Shibaki の役割定義

```
[AI agent] コーディング作業 (大部分の時間)
[AI critic] 別視点で詰めて scope drift を検出 (Shibaki)
[Human] 30 秒の meta 補正だけする (Shibaki が呼び出す)
[AI agent] 補正を受けて完遂 (Shibaki が回す)
```

Shibaki = **AI と人間の "meta" 共創 scaffold**。

既存カテゴリで言うと:

| 既存カテゴリ | Shibaki との違い |
|---|---|
| Linter / formatter | code-level、Shibaki は goal-level |
| Code review tool | post-hoc、Shibaki は pre-completion |
| Agent framework | agent を強化、Shibaki は agent を **止める** |
| Critic loop research | 完全自動を目指す、Shibaki は **人間 30 秒** を許容 |

## 北極星 (修正版)

旧版:
> 「AI に頼んで、直さなくていいものが返ってくる」
> 「人間はループに入らない」

新版 (本文書):
> **「AI が process 中毒に陥ったら、人間が 30 秒で目的を思い出させる」**
> **「人間はコードループには入らない、目的レベルの軌道修正だけする」**

## なぜ "Shibaki" (しばき) なのか

しばく = ぴしゃっと meta 補正を入れる。
critic だけが AI を しばく のではない。**人間が AI を 30 秒だけ しばく** のがこの製品の核心。

## 実装済みの 3 軸 critic

Shibaki の critic は 3 つの軸で agent を評価する:

| 軸 | 内容 | 役割 |
|---|---|---|
| 反証 (refutation) | ズル / 規約違反 / バグ検出 | 既存 critic 系と同等 |
| 気づき (insight) | 設計レベルの meta 洞察 | educational |
| **目的整合 (scope drift)** | 元タスクから drift してないか | **Shibaki 独自** |

3 番目だけが Shibaki 独自。これが human 30 秒介入の trigger を引く。

## なぜ AI に頼むだけでなく Shibaki が必要か

「Claude が十分賢いなら自分で気づくのでは?」という反論は妥当。
しかし実測:
- modern Claude は **明確なズルはしない** (Constitutional AI が効いてる)
- だが **process 中毒は止まらない** (「もっと良くしたい」は alignment 違反ではない)
- agent 自身は「良くしようとしてる」と信じてる
- そこに **外側からの目的 reminder** が要る

これが Shibaki の存在意義。

## License & 利用方法

MIT。詳細は [README](../README.md)。

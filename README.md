# model-router：Claude Agent SDK でターンごとに Opus / Sonnet / Haiku を切り替える

Claude Code の mod（関数フック）で、AI エージェントがターンごと・サブエージェントごとに Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 を使い分けるようにし、その効果を測りました。

mod は、Claude Code の内部イベントに JavaScript / TypeScript の関数でフックするプラグインです。Agent SDK でもフックが動きます（画面への描画はしません）。詳しくは公式ドキュメントを参照してください。

- [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [React to events: Follow a turn](https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn)（今回使った `turn.step` などのイベント）
- [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)

## やったこと

### 1. ルーティングの実装

[plugins/model-router/](plugins/model-router/) は、次のフックで動きます。

| フック | 役割 |
| --- | --- |
| `turn.start` | 依頼文から難易度を判定する |
| `turn.step` | メインループの各リクエストの `model` と `effort` を、判定結果に差し替える |
| `agent.spawn` | モデルを指定していない組み込みのサブエージェントに、モデルを割り当てる（Explore は Haiku、general-purpose は Sonnet、Plan は Opus） |
| `prompt.submit` | 依頼文の先頭の `[opus]` / `[sonnet]` / `[haiku]` で、そのターンのモデルを指定できる |

```ts
on('turn.step', async function* ($, e, next) {
  const tier = await decisions.get(e.turnId) // turn.start で判定済み
  return yield* next({ ...e, model: MODEL_ID[tier], effort: EFFORT[tier] })
})
```

- **判定**: キーワードと文の長さで判定し、確信が持てないときだけ Haiku に判定させます（1回 $0.001 未満）。ルールは [hooks/policy.ts](plugins/model-router/hooks/policy.ts) にあります。
- **キャッシュへの配慮**: プロンプトキャッシュはモデルごとに別なので、切り替えはターン単位にしています。また、会話が 40K トークンを超えたら下位モデルへは切り替えません。

### 2. 振り分けの検証

| 対象 | 方法 |
| --- | --- |
| フックの動作 | 単体テスト10件（`claude plugin test`、API 呼び出しなし） |
| 実際に応答したモデル | Opus を指定したセッションで軽い依頼を出し、API の応答の `message.model` を確認 |
| 評価の全実行 | ルーターの判定と、SDK が報告した課金モデル（`result.modelUsage`）を照合（[eval/check-routing.ts](eval/check-routing.ts)） |

### 3. コスト・レイテンシ・品質の評価

- **タスク**: 小さな JavaScript ライブラリに対する18タスクです。内訳は easy 4、medium 4、hard 4、expert 6 です。
  - easy は回答文で採点します。
  - それ以外は、エージェントの作業後に隠しテストを追加して採点します。
  - expert は仕様書付きのタスクで、semver の範囲判定、数式の評価器、不具合調査、全角を考慮した折り返しと禁則処理、LRU と TTL を組み合わせたキャッシュ、トポロジカルソートです。
- **比較した4通り**: Opus 単独、Opus ＋ model-router（routed）、effort を low にした Opus、Sonnet 単独。
- **条件**:
  - 実行ごとに新しい作業ディレクトリを使い、ユーザー設定は読み込ませていません（`settingSources: []`）。
  - 4通りを交互に実行し、各タスク1回、計72回です。
  - コストは SDK の `total_cost_usd`（定価換算）、レイテンシは `duration_ms` です。

## わかったこと

### 振り分けは判定どおりに動く

- 単体テストはすべて合格しました。
- Opus を指定したセッションで軽い依頼を出すと、実際の応答は `claude-haiku-5-5` が返しました。
- 評価の72回で、判定と課金モデルの不一致は0件でした。
  - Claude Code 本体が毎回行う補助的な Haiku 呼び出し（コストの 0.2% 未満）は、照合から除いています。

### コストとレイテンシは下がる

| 比較対象 | 合格 | 合計コスト | レイテンシ中央値 | 合計レイテンシ |
| --- | --- | --- | --- | --- |
| routed | 18/18 | **$1.237** | 22.6秒 | **387秒** |
| Opus 単独 | 18/18 | $2.966 | 32.4秒 | 589秒 |
| Opus（effort low） | 17/18 ※ | $2.432 | 20.1秒 | 427秒 |
| Sonnet 単独 | 18/18 | $1.555 | **18.6秒** | 431秒 |

※ 不合格の1件は、確認用のコマンドが権限設定で拒否されたことによるものです。

| 難易度 | routed | Opus 単独 | Opus（effort low） | Sonnet 単独 | routed の振り分け先 |
| --- | --- | --- | --- | --- | --- |
| easy | **$0.010** | $0.290 | $0.296 | $0.242 | Haiku 4 |
| medium | **$0.144** | $0.589 | $0.460 | $0.266 | Haiku 2、Sonnet 2 |
| hard | $0.406 | $0.663 | $0.603 | **$0.320** | Sonnet 3、Opus 1 |
| expert | **$0.678** | $1.424 | $1.072 | $0.727 | Sonnet 5、Opus 1 |

- **Opus 単独と比べると**: 合計コストが 58%、合計レイテンシが 34% 減りました。
- **効果の大部分は、軽い依頼を Haiku に回したことによります。** エージェントは毎回、システムプロンプトとツール定義を送ります。この固定費が大きく、その単価がモデルによって最大40倍違うためです。
- **Opus の effort を下げても、コストはあまり下がりません**（Opus 単独の 82%）。上の固定費が減らないためです。
- **Sonnet 単独と比べると**: 合計コストは 20% 低くなりました。ただし、レイテンシの中央値と hard のコストでは、Sonnet 単独のほうが上回りました。

### 品質の維持は評価しきれていない

- **4通りとも、ほぼ全問に合格しました。** 今回のタスクは Sonnet でも解ける難しさで、「難しい依頼を Opus に回すことで品質を保てるか」は確かめられていません。モデル間で差が出るタスク（大きなコードベースの読解、曖昧な要求、長い作業など）での評価が必要です。
- **サブエージェントの振り分けと下げ止めは、単体テストでしか確かめていません。**
- **各タスク1回の実行なので、ばらつきは評価していません。**

## その後：方針の転換と `opusplan` の検証（暫定）

上の router は、ターンの途中でメインのモデルを切り替えます。その後の測定（詳細は [docs/plan.md](docs/plan.md) の P4）で、運用は `opusplan`（計画は Opus、実行は Sonnet）と、計画モードに入る基準を書いた CLAUDE.md に切り替えました。以下は暫定です。繰り返しが足りない項目は、そう書きました。

### やったこと

- Sonnet のサブエージェントと、Sonnet が書いた文書を Opus が見直す形を測った。
- `opusplan` を評価に加え（`eval/run.ts`）、invoice の要件定義・設計書（各3回）と、通し（script・auto 各1回）を測った。人がいないので、計画モードの出入りと計画ファイルの書き込みだけを許可した。計画ファイルはターンごとに残す。

### わかったこと

- **サブエージェントも見直しも、Opus には届かない。** Sonnet のサブエージェントは費用も時間も下がらず、見直しでも文書は Opus に負けたままだった（Opus 6勝、割れ 2）。
- **`opusplan` は狙いどおり動く。** Sonnet が計画モードに入り、計画中は Opus、実行は Sonnet。計画には構成、各節の要点と根拠、食い違いの採り方、テストの観点まで書かれた。
- **文書は Opus に近づくが、並ばない。** 対 Opus の勝ちは 0（負け 1、残り 5 は割れ・引き分け）。対 Sonnet は、要件定義が勝ち 2、設計書が負け 2。
- **通しは auto が良い。** auto は合格で、費用 $1.46・368秒（Opus 単独 $2.41・522秒）。script は不合格（`nonLeapMar`、うるう年でない年の3月）で、$4.25・720秒（Opus 単独 $4.01・909秒）。script の不合格が偶然か、計画の渡り方によるかは、1回ずつでは分けられない。
- **小さな作業は不利。** d1 は費用が約2倍。切り替えでキャッシュを書き直す分が勝つ。
- **未確認：** 繰り返し（script を `opusplan` と Sonnet 単独で各3回）と、Pro 以外のプランでのサブエージェントの動き。

## 使い方

Agent SDK では、`plugins` オプションで読み込みます（[src/router.ts](src/router.ts) の `withRouter`）。

```ts
query({
  prompt,
  options: {
    model: 'claude-opus-5-5',
    plugins: [{ type: 'local', path: './plugins/model-router' }],
    settings: { pluginConfigs: { 'model-router': { options: { classifier: 'hybrid' } } } },
  },
})
```

| オプション | 値 | 既定値 |
| --- | --- | --- |
| `mainRouting` | `route`、または `fixed`（サブエージェントだけ振り分ける） | `route` |
| `classifier` | `heuristic` / `hybrid` / `haiku` | `hybrid` |
| `stickyContextTokens` | 下位モデルへ切り替えない会話の大きさ（トークン） | `40000` |
| `subagentRouting` | 真偽値 | `true` |
| `report` | `turn`（ターンごとの判定とコストを `ui_log` に出す） / `off` | `turn` |

Claude Code では `claude --plugin-dir plugins/model-router` で起動します。`/router-stats` で、モデル別のトークン数と推定コストが見られます。

## 評価の再現

```sh
npm install
npx tsx eval/run.ts                                 # 全タスク × 4通り（課金が発生します）
npx tsx eval/report.ts eval/results/*.jsonl         # 集計
npx tsx eval/check-routing.ts eval/results/*.jsonl  # 判定と課金モデルの照合
claude plugin test plugins/model-router             # mod の単体テスト
```

動作は Claude Code 2.1.295 / Agent SDK 0.3.295 で確認しました。mod の API は early access です。価格（1M トークンあたり、入力 / 出力）は、Opus 5.5 が $4 / $20、Sonnet 5.5 が $2 / $10、Haiku 5.5 が $0.10 / $0.50 です。

# model-router: Agent SDK で Opus / Sonnet / Haiku 5.5 を使い分ける mod

Claude Code の mod（関数フック）で、**ターンごと・サブエージェントごと**に使うモデルを選びます。
Claude Agent SDK からは `plugins` オプションで読み込めます。UI は使わないので、ヘッドレスでも動く部分だけで作っています。

## 仕組み

| フック | やること |
| --- | --- |
| `turn.start` | ユーザー入力から難易度を判定（キーワード＋長さ。`hybrid` のときは判断に迷うものだけ Haiku に聞く） |
| `turn.step` | メインループの各リクエストの `model` / `effort` を判定結果で書き換える |
| `agent.spawn` | 呼び出し側がモデルを指定していない組み込みサブエージェントにモデルを割り当てる（Explore→Haiku、general-purpose→Sonnet（難しい依頼なら Opus）、Plan→Opus） |
| `prompt.submit` | `[opus] …` / `[sonnet] …` / `[haiku] …` のタグでそのターンだけ強制指定（タグはモデルに渡さない） |
| `turn.complete` | 判定とそのターンの推定コストを `ui_log` として出す |
| `/router-stats` | セッションのモデル別トークン数、推定コスト、「同じトークンを全部 Opus で処理した場合」の比較 |

### 品質を落とさずにコストを下げるための設計

- **モデルの切り替えはターン単位にしていて、ステップ単位では切り替えない。** プロンプトキャッシュはモデルごとに別なので、切り替えるとプロンプト全体のキャッシュ書き込みがやり直しになります。1ターン内のツールループでモデルを行き来させると、毎回キャッシュが無効になります。
- **sticky（下げ止め）**：会話が `stickyContextTokens`（既定 40K）を超えたら、下位モデルへの切り替えはしません。キャッシュを書き直す費用が、安いモデルにする節約分を上回りやすいためです。上位モデルへの切り替えは品質を優先して常に許可します。
- **サブエージェントがいちばん効果が大きい。** サブエージェントは毎回まっさらなコンテキストから始まるので、キャッシュ面の損がありません。読むだけの探索（Explore）を Haiku に回すのが一番安全な節約です。
- **SDK ホストが自分で定義したエージェント（`agents` オプション）や、`model` を明示した呼び出しには手を出しません。**
- **effort**：Haiku は `low`、Sonnet は `medium`、Opus は `high`。ただし、セッション本来のモデルのときはセッションの effort 設定をそのまま使います。

価格（1M トークンあたり、入力 / 出力）：Opus 5.5 $4 / $20、Sonnet 5.5 $2 / $10、Haiku 5.5 $0.10 / $0.50（プロンプトが 100K トークンを超えると $0.50 / $2.50）。

## Agent SDK での使い方

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import { withRouter, routerLine } from './src/router'

const options = withRouter(
  { model: 'claude-opus-5-5', allowedTools: ['Read', 'Glob', 'Grep', 'Agent'] },
  { classifier: 'hybrid', stickyContextTokens: 40000 },
)
for await (const m of query({ prompt: '…', options })) {
  const line = routerLine(m) // {"type":"system","subtype":"ui_log","text":"model-router: haiku (...) · turn $0.0046"}
  if (m.type === 'result') console.log(m.modelUsage, m.total_cost_usd) // 実際の課金見込みはこちらを正とする
}
```

`withRouter` がやっているのは、次の2点だけです。

```ts
plugins: [{ type: 'local', path: './plugins/model-router' }],
settings: { pluginConfigs: { 'model-router': { options: { classifier: 'hybrid' } } } },
```

| オプション | 値 | 既定値 |
| --- | --- | --- |
| `mainRouting` | `route` / `fixed`（メインループはセッションのモデル固定、サブエージェントだけ振り分け） | `route` |
| `classifier` | `heuristic`（追加の呼び出しなし） / `hybrid` / `haiku`（毎ターン Haiku で判定） | `hybrid` |
| `stickyContextTokens` | 数値 | `40000` |
| `subagentRouting` | 真偽値 | `true` |
| `report` | `turn` / `off` | `turn` |

## コマンド

```sh
npm install
npm run agent -- "src のファイル一覧を表示して"   # 1回だけ実行
npm run bench                                     # Opus 単独と routed の A/B（課金が発生します）
claude plugin test plugins/model-router           # mod の単体テスト（API 呼び出しなし）
```

`bench` は同じタスクを2通り（Opus 単独 / ルーティングあり）で実行し、コスト（`total_cost_usd`）とレイテンシ（`duration_ms`）を表にします。回答は `bench-out/` に保存されるので、品質は目で見比べてください。

## 注意

- mod の API（関数フック）は early access で、Claude Code のリリースごとに変わる可能性があります（2.1.295 / Agent SDK 0.3.295 で確認）。
- `/router-stats` と per-turn ログのコストは定価からの概算です（Haiku 5.5 のキャッシュ読み取り単価は入力単価の 0.1 倍と仮定）。実際の値は SDK の `result.modelUsage[*].costUSD` を見てください。
- 判定のキーワードは日本語と英語の例です。自分のアプリへの依頼文に合わせて `hooks/policy.ts` の `HARD` / `EASY` を調整するのが一番効きます。

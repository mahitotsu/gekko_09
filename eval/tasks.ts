// The eval's tasks: a prompt the agent gets in a fresh copy of eval/fixture,
// and how it is graded. `answer` tasks grade the final reply; `tests` tasks
// copy eval/hidden/<file> in after the run and require `node --test` to pass
// (the visible tests included, so a fix that breaks them fails).
// A task with several prompts is one conversation: each prompt is sent in the
// same session after the previous turn ends, and only the end state is graded.
// `scenario` tasks come from eval/scenarios (see scenarios/index.ts).
import { SCENARIOS, scenarioTasks } from './scenarios'
import type { StageId } from './scenarios/types'

export type Level = 'easy' | 'medium' | 'scenario'

export type Task = {
  id: string
  level: Level
  prompt: string | readonly string[]
  // Checks the eval itself; run only when named with --tasks.
  smoke?: boolean
  // Builds the workspace instead of copying eval/fixture.
  prepare?: (cwd: string) => Promise<void>
  maxTurns?: number
  // Per prompt: workspace paths to keep once that turn ends (a trailing / is a directory).
  snapshots?: readonly (readonly string[] | undefined)[]
  grade:
    | { kind: 'answer'; check: (reply: string) => boolean }
    | { kind: 'tests'; file: string }
    // stage absent: the whole scenario; otherwise one stage started from the model output.
    | { kind: 'scenario'; scenario: string; stage?: StageId }
    // A document graded later against eval/<rubric> (eval/grade-docs.ts); the run only checks it exists.
    | { kind: 'rubric'; rubric: string; doc: string }
}

export const TASKS: Task[] = [
  {
    id: 'e2-addtax-file',
    level: 'easy',
    prompt: 'addTax 関数はどのファイルで定義されてる？パスだけ答えて。',
    grade: { kind: 'answer', check: r => /src\/money\.js/.test(r) },
  },
  {
    id: 'e4-formatyen-calls',
    level: 'easy',
    prompt: 'src 配下で formatYen が呼び出されている箇所はいくつ？定義と import は数えないで。数字だけ答えて。',
    grade: { kind: 'answer', check: r => r.match(/\d+/)?.[0] === '3' },
  },
  {
    id: 'q1-cart-overflow',
    level: 'medium',
    prompt:
      '新しい Cart に、add("A", 100, 30) を呼び、続けて add("A", 100, 30) を呼ぶ。2回目は上限を超えて例外になる。その後に count() を呼ぶといくつ？コードを読んで、実行しないで、数字だけ答えて。',
    grade: { kind: 'answer', check: r => r.replace(/,/g, '').match(/\d+/)?.[0] === '60' },
  },
  {
    id: 'q2-coupon-total',
    level: 'medium',
    prompt:
      '新しい Cart に add("X", 1980, 1) を呼び、applyCoupon("S", 10) と applyCoupon("T", 20) をこの順に呼ぶ。そのあと total() はいくつ？コードを読んで、実行しないで、数字だけ答えて。',
    grade: { kind: 'answer', check: r => r.replace(/,/g, '').match(/\d+/)?.[0] === '1568' },
  },
  {
    id: 'j1-reserve-race',
    level: 'medium',
    prompt:
      'Inventory.reserve を、同じ sku に対して await せずに続けて2回呼ぶ。在庫が1のとき、どうなる？結果と、その原因を、コードの箇所を挙げて、3文以内で説明して。コードは変えないで。',
    grade: {
      kind: 'answer',
      // Both calls succeed, and the cause is the gap between get and set.
      check: r =>
        /(両方|2(件|回|つ)とも|どちらも|二重|2重)/.test(r) &&
        /(get.{0,40}set|set.{0,40}get|読(み|ん)?.{0,20}書|間に|競合|レース|race|アトミック|排他|割り込)/i.test(r),
    },
  },
  {
    id: 'j2-cart-fix',
    level: 'medium',
    prompt:
      'Cart.add で、上限を超えて例外になったときに、既存の行の数量が増えたまま残る。これを直す方針を決めて、どこをどう変えるかと、その理由を、3文以内で答えて。コードは変えないで。',
    grade: {
      kind: 'answer',
      // The check must come before the quantity is added, and the existing line must be mentioned.
      check: r =>
        /(足す前|加算する前|増やす前|変更する前|更新する前|先に.{0,20}(検査|チェック|判定)|(検査|チェック|判定).{0,20}先|前に.{0,20}(検査|チェック|判定|throw|例外))/.test(r) &&
        /(既存|同じ sku|同じSKU|すでに.{0,10}行|行オブジェクト|line)/.test(r),
    },
  },
  {
    id: 'm1-negative-yen',
    level: 'medium',
    prompt: 'formatYen にマイナスの金額を渡すと "¥-1,200" になってしまう。"-¥1,200" の形式にして。',
    grade: { kind: 'tests', file: 'm1-negative-yen.test.js' },
  },
  {
    id: 's1-max-cart',
    level: 'easy',
    prompt: 'カートに入れられる商品の上限を、50個から100個に変えて。テストが通る状態にしておいて。',
    grade: { kind: 'tests', file: 's1-max-cart.test.js' },
  },
  {
    id: 'd1-inventory-design',
    level: 'medium',
    prompt:
      '在庫の予約で、同じ商品に同時に注文が入ると在庫以上に予約が通ってしまう問題がある。store のインターフェース（get/set）は変えられない前提で、対策の設計を docs/inventory-design.md に書いて。実装はしないで。',
    grade: { kind: 'rubric', rubric: 'rubric/d1-inventory-design.md', doc: 'docs/inventory-design.md' },
  },
  {
    id: 'd3-cart-guide',
    level: 'medium',
    prompt:
      'src/cart.js の Cart を、使う側の開発者向けに説明する文書を docs/cart-guide.md に書いて。公開メソッドの使い方、金額の計算の順序、使うときの注意点を入れて。コードは変えないで。',
    grade: { kind: 'rubric', rubric: 'rubric/d3-cart-guide.md', doc: 'docs/cart-guide.md' },
  },
  {
    id: 'd4-coupon-spec',
    level: 'medium',
    prompt:
      'カートに、クーポンを複数枚つかったときのルール（併用できるか、枚数の上限、割引を適用する順序）を決めたい。仕様のたたき台を docs/coupon-spec.md に書いて。実装はしないで。',
    grade: { kind: 'rubric', rubric: 'rubric/d4-coupon-spec.md', doc: 'docs/coupon-spec.md' },
  },
  {
    // python3 is not an allowed command (and, unlike `git status`, not one
    // Claude Code allows on its own as read-only), so the run must record a denial.
    id: 'p0-denied',
    level: 'easy',
    smoke: true,
    prompt: 'Bash で python3 -c "print(6*7)" を実行して、出力をそのまま見せて。ほかの方法は使わないで。',
    grade: { kind: 'answer', check: () => true },
  },
  {
    // Reads outside the run's directory must be refused (the image holds the
    // scenarios' reference solutions): the run must record a denial.
    id: 'p0-outside',
    level: 'easy',
    smoke: true,
    prompt: 'Bash で cat /etc/hostname を実行して、出力をそのまま見せて。ほかの方法は使わないで。',
    grade: { kind: 'answer', check: () => true },
  },
  ...SCENARIOS.flatMap(scenarioTasks),
]

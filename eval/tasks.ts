// The eval's tasks: a prompt the agent gets in a fresh copy of eval/fixture,
// and how it is graded. `answer` tasks grade the final reply; `tests` tasks
// copy eval/hidden/<file> in after the run and require `node --test` to pass
// (the visible tests included, so a fix that breaks them fails).
// A task with several prompts is one conversation: each prompt is sent in the
// same session after the previous turn ends, and only the end state is graded.
// `scenario` tasks come from eval/scenarios (see scenarios/index.ts).
import { SCENARIOS, scenarioTasks } from './scenarios'
import type { StageId } from './scenarios/types'

export type Level = 'easy' | 'medium' | 'hard' | 'expert' | 'scenario'

// The kind of work a small task is (P2): calibration finds the cheapest model
// that does each kind reliably, and the router is judged against that.
export type WorkKind = 'investigate' | 'small-change' | 'implement' | 'bugfix' | 'design'

export type Task = {
  id: string
  level: Level
  prompt: string | readonly string[]
  // Checks the eval itself (P0); run only when named with --tasks.
  smoke?: boolean
  fixture?: string // folder under eval/, default 'fixture'
  // Builds the workspace instead of copying `fixture`.
  prepare?: (cwd: string) => Promise<void>
  maxTurns?: number
  // Per prompt: workspace paths to keep once that turn ends (a trailing / is a directory).
  snapshots?: readonly (readonly string[] | undefined)[]
  // final: kept out of every run unless --final is given (untouched while the router is tuned).
  split?: 'dev' | 'final'
  kind?: WorkKind
  grade:
    | { kind: 'answer'; check: (reply: string) => boolean }
    | { kind: 'tests'; file: string; dir?: string }
    // stage absent: the whole scenario; otherwise one stage started from the model output.
    | { kind: 'scenario'; scenario: string; stage?: StageId }
    // A document graded later against eval/<rubric> (eval/grade-docs.ts); the run only checks it exists.
    | { kind: 'rubric'; rubric: string; doc: string }
}

export const TASKS: Task[] = [
  {
    id: 'e1-timeout',
    level: 'easy',
    prompt: 'DEFAULT_TIMEOUT_MS の値はいくつ？数値だけ答えて。',
    grade: { kind: 'answer', check: r => /(^|\D)3500(\D|$)/.test(r) },
  },
  {
    id: 'e2-addtax-file',
    level: 'easy',
    prompt: 'addTax 関数はどのファイルで定義されてる？パスだけ答えて。',
    grade: { kind: 'answer', check: r => /src\/money\.js/.test(r) },
  },
  {
    id: 'e3-todos',
    level: 'easy',
    prompt: 'src 配下で TODO コメントがあるファイルを全部挙げて。',
    grade: { kind: 'answer', check: r => /cart\.js/.test(r) && /csv\.js/.test(r) && !/(money|report|dates|inventory|config)\.js/.test(r) },
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
    id: 'm1-negative-yen',
    level: 'medium',
    prompt: 'formatYen にマイナスの金額を渡すと "¥-1,200" になってしまう。"-¥1,200" の形式にして。',
    grade: { kind: 'tests', file: 'm1-negative-yen.test.js' },
  },
  {
    id: 'm2-cart-clear',
    level: 'medium',
    prompt: 'Cart に、商品とクーポンをすべて空にする clear() メソッドを追加して。',
    grade: { kind: 'tests', file: 'm2-cart-clear.test.js' },
  },
  {
    id: 'm3-csv-quotes',
    level: 'medium',
    prompt:
      'parseCsv が "a,\\"b,c\\",d" のようなダブルクォートで囲まれたカンマ入りのフィールドを正しく扱えない。RFC 4180 に沿ってクォート（"" によるエスケープも）に対応させて。',
    grade: { kind: 'tests', file: 'm3-csv-quotes.test.js' },
  },
  {
    id: 'mt1-negative-yen',
    level: 'medium',
    smoke: true,
    prompt: [
      'formatYen はマイナスの金額をどう表示する？コードを読んで、例を1つ挙げて説明して。まだ変更はしないで。',
      'それを "-¥1,200" の形式に直して。',
    ],
    grade: { kind: 'tests', file: 'm1-negative-yen.test.js' },
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
  {
    // P1: a conversation whose history is long enough that a lost cache shows.
    // Turn 1 reads every source file; turns 2-4 answer from it in one request.
    id: 'p1-history',
    level: 'easy',
    smoke: true,
    prompt: [
      'src 配下のファイルをすべて Read で読んで、それぞれの役割を1行ずつ説明して。',
      'addTax が定義されているファイルのパスだけ答えて。ツールは使わないで。',
      'formatYen が定義されているファイルのパスだけ答えて。ツールは使わないで。',
      'Cart クラスが定義されているファイルのパスだけ答えて。ツールは使わないで。',
    ],
    grade: { kind: 'answer', check: r => /cart\.js/.test(r) },
  },
  {
    // P1: turn 2 needs thought and no tools, so its tokens show the effort it ran at.
    id: 'p1-think',
    level: 'easy',
    smoke: true,
    prompt: [
      'DEFAULT_TIMEOUT_MS の値はいくつ？数値だけ答えて。',
      'ツールは使わずに答えて。1 から 2000 までの整数のうち、各桁の数字の和が 7 の倍数で、かつ 3 で割り切れないものはいくつある？最後に数だけを書いて。',
    ],
    grade: { kind: 'answer', check: r => /(^|\D)215(\D|$)/.test(r) },
  },
  {
    id: 's1-max-cart',
    level: 'easy',
    prompt: 'カートに入れられる商品の上限を、50個から100個に変えて。テストが通る状態にしておいて。',
    grade: { kind: 'tests', file: 's1-max-cart.test.js' },
  },
  {
    id: 's2-report-header',
    level: 'easy',
    prompt: 'salesReport の出力の先頭に「売上レポート」という見出しの行を付けて。テストが通る状態にしておいて。',
    grade: { kind: 'tests', file: 's2-report-header.test.js' },
  },
  {
    id: 's3-timeout-env',
    level: 'easy',
    prompt:
      'DEFAULT_TIMEOUT_MS を、環境変数 SHOP_TIMEOUT_MS で上書きできるようにして。未設定のときや数値でないときは、今の値のままにして。テストが通る状態にしておいて。',
    grade: { kind: 'tests', file: 's3-timeout-env.test.js' },
  },
  {
    id: 'd1-inventory-design',
    level: 'medium',
    prompt:
      '在庫の予約で、同じ商品に同時に注文が入ると在庫以上に予約が通ってしまう問題がある。store のインターフェース（get/set）は変えられない前提で、対策の設計を docs/inventory-design.md に書いて。実装はしないで。',
    grade: { kind: 'rubric', rubric: 'rubric/d1-inventory-design.md', doc: 'docs/inventory-design.md' },
  },
  {
    id: 'd2-csv-design',
    level: 'medium',
    prompt: 'parseCsv を RFC 4180 に対応させたい。設計を docs/csv-design.md に書いて。実装はしないで。',
    grade: { kind: 'rubric', rubric: 'rubric/d2-csv-design.md', doc: 'docs/csv-design.md' },
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
    id: 'm4-tax-rounding',
    level: 'medium',
    prompt: 'addTax の結果がコメントに書かれた仕様どおりになっていないらしい。確認して直して。',
    grade: { kind: 'tests', file: 'm4-tax-rounding.test.js' },
  },
  {
    id: 'h1-inventory-race',
    level: 'hard',
    prompt:
      '本番で、同じ商品に注文が同時に入ると在庫以上に予約が通ってしまう事象が起きている。store のインターフェース（get/set）は変えられない前提で、原因を調べて直して。',
    grade: { kind: 'tests', file: 'h1-inventory-race.test.js' },
  },
  {
    id: 'h2-cart-capacity',
    level: 'hard',
    prompt:
      'ユーザー報告：「カートに同じ商品が30個入っている状態で15個追加しようとすると、上限50個以内のはずなのに cart is full になる。しかもエラーのあと個数が変わってしまっている」。原因を調べて直して。',
    grade: { kind: 'tests', file: 'h2-cart-capacity.test.js' },
  },
  {
    id: 'h3-coupons',
    level: 'hard',
    prompt:
      'クーポンの仕様を変更したい。(1) 同じコードのクーポンは何回適用しても1回分だけ有効、(2) 複数のクーポンは割引率を掛け算ではなく足し算する（10% と 5% なら 15% 引き）、(3) 割引の合計は 100% を上限にする。この仕様で実装して。',
    grade: { kind: 'tests', file: 'h3-coupons.test.js' },
  },
  {
    id: 'h4-holidays',
    level: 'hard',
    prompt:
      'businessDaysBetween を祝日対応にしたい。祝日の配列（YYYY-MM-DD）を省略可能な3番目の引数で受け取って除外し（土日の祝日を二重に引かないこと）、既存の呼び出しはそのまま動くようにして。あわせて、開始日から営業日で n 日後の日付を返す addBusinessDays(start, n, holidays) を同じファイルに追加して。',
    grade: { kind: 'tests', file: 'h4-holidays.test.js' },
  },

  // expert: a separate fixture (eval/fixture-hard), so the tasks above keep the
  // environment their recorded results were measured in.
  ...(
    [
      ['x1-semver', 'docs/semver.md の仕様どおりに src/semver.js の satisfies を実装して。'],
      ['x2-expr', 'docs/expr.md の仕様で src/expr.js の evaluate を実装して。'],
      [
        'x3-autosave',
        'エディタの自動保存（src/autosave.js）について、「最後の編集が保存されないことがある」「閉じたあとに同じ内容が2回保存されることがある」と報告があった。原因を調べて直して。',
      ],
      ['x4-wrap', 'docs/wrap.md の仕様で src/wrap.js の wrapText を実装し直して。'],
      ['x5-cache', 'docs/cache.md の仕様で src/cache.js の TtlCache を完成させて。'],
      ['x6-toposort', 'docs/toposort.md の仕様で src/toposort.js を直して。'],
    ] as const
  ).map(([id, prompt]): Task => ({
    id,
    level: 'expert',
    prompt,
    fixture: 'fixture-hard',
    grade: { kind: 'tests', file: `${id}.test.js`, dir: 'hidden-hard' },
  })),
  ...SCENARIOS.flatMap(scenarioTasks),
]

// Kind and split of the small tasks. About a third of each kind is final, so
// the router's judgment can be checked on tasks it was not tuned on (P5).
const SMALL: Record<string, [WorkKind, 'dev' | 'final']> = {
  'e1-timeout': ['investigate', 'dev'],
  'e2-addtax-file': ['investigate', 'dev'],
  'e3-todos': ['investigate', 'final'],
  'e4-formatyen-calls': ['investigate', 'dev'],
  'q1-cart-overflow': ['investigate', 'dev'],
  'q2-coupon-total': ['investigate', 'dev'],
  'm1-negative-yen': ['small-change', 'dev'],
  'm2-cart-clear': ['small-change', 'final'],
  's1-max-cart': ['small-change', 'dev'],
  's2-report-header': ['small-change', 'dev'],
  's3-timeout-env': ['small-change', 'final'],
  'd1-inventory-design': ['design', 'dev'],
  'd2-csv-design': ['design', 'final'],
  'd3-cart-guide': ['design', 'dev'],
  'd4-coupon-spec': ['design', 'dev'],
  'm3-csv-quotes': ['implement', 'dev'],
  'h3-coupons': ['implement', 'dev'],
  'h4-holidays': ['implement', 'final'],
  'x1-semver': ['implement', 'dev'],
  'x2-expr': ['implement', 'final'],
  'x4-wrap': ['implement', 'dev'],
  'x5-cache': ['implement', 'dev'],
  'm4-tax-rounding': ['bugfix', 'dev'],
  'h1-inventory-race': ['bugfix', 'dev'],
  'h2-cart-capacity': ['bugfix', 'final'],
  'x3-autosave': ['bugfix', 'dev'],
  'x6-toposort': ['bugfix', 'final'],
}
for (const t of TASKS) {
  const k = SMALL[t.id]
  if (k) [t.kind, t.split] = k
}

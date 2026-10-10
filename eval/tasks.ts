// The eval's tasks: a prompt the agent gets in a fresh copy of eval/fixture,
// and how it is graded. `answer` tasks grade the final reply; `tests` tasks
// copy eval/hidden/<file> in after the run and require `node --test` to pass
// (the visible tests included, so a fix that breaks them fails).
// A task with several prompts is one conversation: each prompt is sent in the
// same session after the previous turn ends, and only the end state is graded.

export type Level = 'easy' | 'medium' | 'hard' | 'expert'

export type Task = {
  id: string
  level: Level
  prompt: string | readonly string[]
  // Checks the eval itself (P0); run only when named with --tasks.
  smoke?: boolean
  fixture?: string // folder under eval/, default 'fixture'
  grade: { kind: 'answer'; check: (reply: string) => boolean } | { kind: 'tests'; file: string; dir?: string }
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
]

# cache: TtlCache

`src/cache.js` の `TtlCache` は、件数の上限（LRU）と有効期限（TTL）を持つキャッシュ。

```js
const cache = new TtlCache({ maxEntries: 100, ttlMs: 60_000, now: () => Date.now(), onEvict: (key, value, reason) => {} })
```

- `maxEntries`: 生きている（期限切れでない）エントリの上限。省略時は `Infinity`。
- `ttlMs`: 既定の有効期限。省略時は `Infinity`。
- `now`: 現在時刻（ミリ秒）を返す関数。省略時は `Date.now`。
- `onEvict(key, value, reason)`: エントリがキャッシュから取り除かれるたびに呼ばれる。省略可。

## 期限切れ

エントリは `set` した時刻を `t` として、`now() - t >= ttl` になった時点で期限切れ。期限切れのエントリは見つけた時点で取り除き、`onEvict(key, value, 'expired')` を呼ぶ（遅延削除）。

## 新しさ（LRU の順序）

- `set` と、ヒットした `get` は、そのエントリを最も新しくする。
- `peek`, `has`, `keys`, `size` は新しさを変えない。
- `get` は新しさを変えるが、有効期限は延ばさない。

## メソッド

- `set(key, value, { ttlMs } = {})`: 値を入れる。`ttlMs` を渡すとそのエントリだけ有効期限を上書きする。
  - 同じキーが生きていれば、古い値について `onEvict(key, oldValue, 'replaced')` を呼んでから置き換える。期限切れなら `'expired'` で取り除いてから入れる。
  - 入れたあと、生きているエントリが `maxEntries` を超えていたら、まず期限切れのエントリをすべて取り除き（`'expired'`）、それでも超えていれば最も古いものから `onEvict(key, value, 'capacity')` で取り除く。
- `get(key)`: 生きていれば値を返し、なければ `undefined`。
- `peek(key)`: `get` と同じだが新しさを変えない。
- `has(key)`: 生きていれば `true`。
- `delete(key)`: 生きていれば `onEvict(key, value, 'deleted')` を呼んで取り除き `true`。期限切れなら `'expired'` で取り除いて `false`。なければ `false`。
- `size`（getter）: 生きているエントリ数。数える前に期限切れをすべて取り除く。
- `keys()`: 生きているキーの配列を、古いものから新しいものの順で返す。返す前に期限切れをすべて取り除く。

期限切れのエントリを「すべて取り除く」とき、`onEvict` は古いものから新しいものの順に呼ぶ。

import type { Scenario } from '../types'

export const expense: Scenario = {
  id: 'expense',
  split: 'final',
  title: '経費精算（しらかば技研の経費精算システム）',
  stages: [
    {
      id: 'requirements',
      prompt:
        'docs/資料 にある議事録・経費精算規程・連携仕様書を読んで、経費精算システムの要件を docs/requirements.md にまとめてください。議事録の途中で決定が変わった点は最終の決定に従い、どの回で何が変わったかも書いてください。見送りになった要望は分けて書いてください。',
      produces: ['docs/requirements.md'],
    },
    {
      id: 'design',
      prompt:
        'docs/requirements.md をもとに、設計を docs/design.md に書いてください。モジュールの構成、データの流れ、審査の手順（期限、領収書、宿泊費、日当、会議費と接待費、物品、承認経路、支払日）、エラー処理を含めてください。まだ実装はしないでください。',
      produces: ['docs/design.md'],
    },
    {
      id: 'implement',
      prompt: 'docs/design.md に沿って実装してください。コマンドは連携仕様書のとおりにしてください。',
      followUps: [
        'サンプルデータ（docs/資料/data）で 2026-10 分を実行して、連携仕様書の例と一致するか確かめてください。違っていたら直してください。',
      ],
      produces: ['src/'],
    },
    {
      id: 'test',
      prompt:
        'テストを test/ に書いて、npm test が通るようにしてください。期限の境界、領収書の境界、宿泊費の上限と改定日、日当、会議費と接待費の境界、物品の境界、承認経路の境界、支払日の土日、入力の不整合を含めてください。',
      produces: ['test/'],
    },
    {
      id: 'report',
      prompt:
        '最終の仕様書を docs/spec.md に、作業の報告書を docs/report.md にまとめてください。報告書には、要件の変更への対応、テストの内容と結果、残っている課題を書いてください。',
      followUps: ['報告書の要点を3行で教えてください。'],
      produces: ['docs/spec.md', 'docs/report.md'],
    },
  ],
  autonomousPrompt:
    'docs/資料 にある議事録・経費精算規程・連携仕様書をもとに、経費精算システムを作ってください。次の順に進めて、それぞれの成果物を残してください。\n' +
    '1. 要件を docs/requirements.md にまとめる（議事録で決定が変わった点は最終の決定に従い、変更の経緯と見送りの要望も書く）\n' +
    '2. 設計を docs/design.md に書く（モジュールの構成、データの流れ、審査の手順、エラー処理）\n' +
    '3. 連携仕様書のとおりのコマンドを実装し、サンプルデータで連携仕様書の例と一致することを確かめる\n' +
    '4. テストを test/ に書き、npm test が通るようにする（期限・領収書・宿泊費・日当・会議費・物品・承認経路の境界、支払日の土日、入力の不整合を含める）\n' +
    '5. 最終の仕様書を docs/spec.md に、作業の報告書（要件の変更への対応、テストの内容と結果、残っている課題）を docs/report.md にまとめる',
}

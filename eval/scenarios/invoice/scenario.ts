import type { Scenario } from '../types'

export const invoice: Scenario = {
  id: 'invoice',
  split: 'dev',
  title: '受注・請求（みなと文具の請求書発行システム）',
  stages: [
    {
      id: 'requirements',
      prompt:
        'docs/資料 にある議事録・請求業務規程・連携仕様書を読んで、請求書発行システムの要件を docs/requirements.md にまとめてください。議事録の途中で決定が変わった点は最終の決定に従い、どの回で何が変わったかも書いてください。見送りになった要望は分けて書いてください。',
      produces: ['docs/requirements.md'],
    },
    {
      id: 'design',
      prompt:
        'docs/requirements.md をもとに、設計を docs/design.md に書いてください。モジュールの構成、データの流れ、計算の手順（請求期間、単価、数量割引、送料、返品、消費税、繰越）、エラー処理を含めてください。まだ実装はしないでください。',
      produces: ['docs/design.md'],
    },
    {
      id: 'implement',
      prompt: 'docs/design.md に沿って実装してください。コマンドは連携仕様書のとおりにしてください。',
      followUps: [
        'サンプルデータ（docs/資料/data）で 2026-09 分を実行して、連携仕様書の例と一致するか確かめてください。違っていたら直してください。',
      ],
      produces: ['src/'],
    },
    {
      id: 'test',
      prompt:
        'テストを test/ に書いて、npm test が通るようにしてください。請求期間の境界、価格改定の適用日、送料無料の境界、数量割引の境界、返品、端数処理の各方法、金額がマイナスの場合、繰越、取消の注文、入力の不整合を含めてください。',
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
    'docs/資料 にある議事録・請求業務規程・連携仕様書をもとに、請求書発行システムを作ってください。次の順に進めて、それぞれの成果物を残してください。\n' +
    '1. 要件を docs/requirements.md にまとめる（議事録で決定が変わった点は最終の決定に従い、変更の経緯と見送りの要望も書く）\n' +
    '2. 設計を docs/design.md に書く（モジュールの構成、データの流れ、計算の手順、エラー処理）\n' +
    '3. 連携仕様書のとおりのコマンドを実装し、サンプルデータで連携仕様書の例と一致することを確かめる\n' +
    '4. テストを test/ に書き、npm test が通るようにする（請求期間・価格改定・送料無料・数量割引の境界、返品、端数処理の各方法、マイナスの金額、繰越、取消、入力の不整合を含める）\n' +
    '5. 最終の仕様書を docs/spec.md に、作業の報告書（要件の変更への対応、テストの内容と結果、残っている課題）を docs/report.md にまとめる',
}

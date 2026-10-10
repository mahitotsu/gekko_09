import type { Scenario } from '../types'

export const attendance: Scenario = {
  id: 'attendance',
  split: 'final',
  title: '勤怠集計（ひいらぎ工業の勤怠集計と残業代の計算）',
  stages: [
    {
      id: 'requirements',
      prompt:
        'docs/資料 にある議事録・就業規程・連携仕様書を読んで、勤怠集計システムの要件を docs/requirements.md にまとめてください。議事録の途中で決定が変わった点は最終の決定に従い、どの回で何が変わったかも書いてください。見送りになった要望は分けて書いてください。',
      produces: ['docs/requirements.md'],
    },
    {
      id: 'design',
      prompt:
        'docs/requirements.md をもとに、設計を docs/design.md に書いてください。モジュールの構成、データの流れ、集計の手順（打刻の丸め、休憩、日の種類、法定外と週40時間、月60時間超、深夜、賃金と端数処理、残業の注意）、エラー処理を含めてください。まだ実装はしないでください。',
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
        'テストを test/ に書いて、npm test が通るようにしてください。丸めの境界、休憩の境界、深夜の境界と日またぎ、日の種類、1日8時間と週40時間の法定外、法定休日、月60時間の境界と適用月、端数処理、残業の注意の境界、入力の不整合を含めてください。',
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
    'docs/資料 にある議事録・就業規程・連携仕様書をもとに、勤怠集計システムを作ってください。次の順に進めて、それぞれの成果物を残してください。\n' +
    '1. 要件を docs/requirements.md にまとめる（議事録で決定が変わった点は最終の決定に従い、変更の経緯と見送りの要望も書く）\n' +
    '2. 設計を docs/design.md に書く（モジュールの構成、データの流れ、集計の手順、エラー処理）\n' +
    '3. 連携仕様書のとおりのコマンドを実装し、サンプルデータで連携仕様書の例と一致することを確かめる\n' +
    '4. テストを test/ に書き、npm test が通るようにする（丸め・休憩・深夜・日の種類・法定外と週40時間・60時間超と適用月・端数処理・注意の境界、入力の不整合を含める）\n' +
    '5. 最終の仕様書を docs/spec.md に、作業の報告書（要件の変更への対応、テストの内容と結果、残っている課題）を docs/report.md にまとめる',
}

# progress（最終更新: 2026-10-09）

## 決定事項
| 項目 | 決定 | 備考 |
|---|---|---|
| 開発手段 | PWA | 将来: Android=TWA / iOS=Capacitor でストア化可能 |
| 配信 | GitHub Actions(1日1回) → GitHub Pages | ユーザー選択。公開URLになる点は下記「リスク」参照。配信先は差し替え可能な構成にする |
| 3・9月期以外の決算日 | JPX Excel 取込 ＋（将来）推定日 | 下記調査で JPX Excel が全決算期をカバーすると判明 |

## 調査結果（2026-10-09）
- J-Quants は V2 API に移行済み。認証は `x-api-key` ヘッダの APIキー方式（旧リフレッシュトークン方式は廃止）。Base: `https://api.jquants.com/v2`
- `/equities/earnings-calendar`: 3・9月期のみ、全プラン「直近データ」→ 無料でも使える
- `/fins/earnings-date`: 全決算期対応だが **Free は12週間遅延** → 今後の予定取得には使えない（推定日の材料には使える）
- `/equities/master`（銘柄一覧）: Free は12週間遅延 → 直近の新規上場は欠ける
- **JPX「決算発表予定日」Excel**（https://www.jpx.co.jp/listing/event-schedules/financial-announcement/）は「○月に四半期末/期末を迎えた会社」単位で**全決算期**を掲載。ローツェ(6323) も 8月末四半期分で 2026-10-08 として掲載を確認。robots.txt は全許可。
  → **メインデータ源は JPX Excel**、J-Quants は銘柄一覧（検索用）＋3・9月期のクロスチェック。

## リスク・未解決
- GitHub Pages は公開URL。J-Quants 由来データ（銘柄一覧等）の再配布に当たりうる。自分用プロト段階では「URLを広めない」で運用、販売前に要再検討。
- 販売時: JPX は法人向け有料「決算発表予定日情報提供サービス」を提供しており、商用利用はそちらの契約が必要になる見込み。

## 実装状況
- [x] プロジェクト作成（~/kabu-calendar, git init, CLAUDE.md）
- [ ] データ取得スクリプト（JPX Excel / J-Quants / 米国イベントJSON）
- [ ] PWA本体（カレンダー＋日別リスト、検索、ウォッチリスト、最終更新表示）
- [ ] GitHub Actions（毎日自動更新 → Pages デプロイ）

## 【次のアクション】
**CLAUDE CODE CONTINUES** — データ取得スクリプトと PWA 本体を実装中。

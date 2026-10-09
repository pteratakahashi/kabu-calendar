# progress（最終更新: 2026-10-09 19:05）

## 決定事項
| 項目 | 決定 | 備考 |
|---|---|---|
| 開発手段 | PWA | 将来: Android=TWA / iOS=Capacitor でストア化可能 |
| 配信 | GitHub Actions(毎日18:30 JST) → GitHub Pages | ユーザー選択。公開URLになる点は「リスク」参照 |
| 決算日データ | **JPX Excel をメイン**、J-Quants は補助 | JPX Excel が全決算期をカバーすると判明（下記） |

## 調査結果（2026-10-09）
- J-Quants は V2 API。認証は `x-api-key` ヘッダ（旧トークン方式は廃止）。Base: `https://api.jquants.com/v2`
- `/equities/earnings-calendar`: 3・9月期のみ、全プランで直近データ可
- `/fins/earnings-date`: 全決算期対応だが **Free は12週間遅延** → 今後の予定には使えない
- `/equities/master`（銘柄一覧）: Free は12週間遅延
- **JPX「決算発表予定日」Excel** は「○月に四半期末/期末を迎えた会社」単位で全決算期を掲載。ローツェ(6323) 2Q = 2026-10-08 を確認。robots.txt 全許可。JPX は毎営業日17時頃更新。

## 実装状況
- [x] データ取得 `scripts/fetch_data.py`（JPX Excel 3,357件取得確認。キー無しでも動作。J-Quants はキーがあれば銘柄一覧＋3/9月期を補完。過去分は400日蓄積）
- [x] 米国イベント `data/us_events.json`（手入力。雇用統計・CPI・FOMC は BLS/FRB 公表日、NVDA/MU/ジャクソンホールは「予定」扱い）。時刻は日本時間
- [x] PWA `site/`（月カレンダー＋社数、ウォッチ銘柄は黄色、米国イベントは赤、日別リスト＋絞り込み、検索（半角/全角どちらでも可）、ウォッチタブ、最終更新表示（36h超で赤）、オフライン対応）
- [x] ヘッドレス Edge で動作確認（ライト/ダーク、390px 幅、横スクロール無し、JSエラー無し）
- [x] GitHub Actions `.github/workflows/update.yml`
- [x] ローカル git commit（0e18f1e）
- [ ] GitHub リポジトリ作成・push・Pages 有効化 ← ユーザー承認待ち
- [ ] J-Quants キー登録（任意だが推奨）

## 将来機能の設計メモ（今回は未実装）
- **決算前日プッシュ通知**: iOS 16.4+ はホーム画面追加済み PWA で Web Push 可。ただし送信側サーバーが必要（購読情報とウォッチリストの保管先）。案: Cloudflare Workers + KV（無料枠）に購読とウォッチを保存し、Actions の日次ジョブ後に Worker から送信。ウォッチリストは今 localStorage のみ → その時点でサーバー同期を追加する。`sw.js` に push ハンドラの差し込み口あり。
- **TDnet 適時開示速報**: 有料アドオン。上記の通知基盤に相乗り。
- **推定決算日**: 次の四半期がまだ JPX に載っていない銘柄向けに、前年同期の発表日から推定表示（J-Quants Free の12週遅延データで作れる）。

## リスク・未解決
- GitHub Pages 無料枠はリポジトリも公開になる。J-Quants 由来データ（銘柄一覧）も公開状態になるため、自分用の間は URL を広めない。販売前に配信方式を再検討。
- 販売時: JPX は法人向け有料「決算発表予定日情報提供サービス」を提供しており、JPX Excel の商用再配布はその契約が必要になる見込み。収益化前に要確認。
- APIキーは本番運用開始後にローテーション（ダッシュボードで再発行 → `gh secret set` で差し替え → 旧キー無効化）。

## 【次のアクション】
**USER ACTION REQUIRED**
1. GitHub に公開リポジトリ `pteratakahashi/kabu-calendar` を作って push し、Pages を有効化してよいか返答する（OK なら Claude Code が gh で実行）
2. （推奨・後からでも可）J-Quants の APIキーを取得し、自分のターミナルで Secrets に登録する（チャットには貼らない）
   - https://jpx-jquants.com/ → 新規登録 → Free プラン → ダッシュボードで「APIキー発行」
   - リポジトリ作成後に `gh secret set JQUANTS_API_KEY -R pteratakahashi/kabu-calendar` を実行し、プロンプトでキーを貼り付け

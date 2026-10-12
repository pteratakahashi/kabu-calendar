# イベントデータ更新ガイド（毎日の Claude 定期実行用）

`data/events.json` は「株価に影響する国内外のイベント」の手入力（Claude 調査）リスト。
GitHub Actions が毎日 18:30 JST にこれを読み込み、SQ（自動計算）と国内大型決算（JPX）を足してアプリに配信する。

## 毎日の作業
1. 今日（JST）から **14日先まで** の予定を調べ直す。
2. 新しく確定した予定を追加、日程・時刻が変わったものを修正、中止を削除。
3. `tentative: true` のもので日程が確定したら `false` にする。
4. **過去分は消さない**（年をまたいでも消さない。「過去10回の反応」の比較に使う）。同じ種類の指標は id のスラッグ（日付より後ろ。us-jobs / us-cpi / fomc / boj 等）を既存と揃える。
5. 予定外ニュースを `data/news.json` に追加（下記「予定外ニュース」）。
6. `python3 scripts/validate_events.py`（events.json と news.json の両方を検証）が通ることを確認して commit & push。

## 対象にするもの（例）
- 米国: 雇用統計、CPI、PPI、PCE、GDP、小売売上高、ISM(製造業/非製造業)、ミシガン大消費者信頼感、FOMC(結果・議事要旨)、FRB議長発言(重要なもの)、ジャクソンホール
- 日本: 日銀会合(結果・総裁会見)、日銀総裁講演、短観、全国/東京CPI、GDP、景気動向指数、景気ウォッチャー、国際収支、工作機械受注、機械受注
- 海外企業決算（日本株に波及するもの）: NVIDIA、TSMC(四半期決算＋**月次売上**)、ASML、マイクロン、ブロードコム、AMD、インテル、Apple、Microsoft、Alphabet、Amazon、Meta、テスラ、サムスン(暫定決算)
- 国内大型決算のうち **時刻が分かるもの**（ファストリ 15:00頃 など）。日付だけなら JPX データで自動表示されるので不要
- 海外企業決算には `ticker`（米国ティッカー。例 NVDA, TSM, 005930.KS）を付ける。株価の反応チャートに使う
- 中国: GDP、PMI、貿易統計 / 欧州: ECB理事会
- 祝日による米国・日本の休場

## スキーマ
```json
{
  "id": "2026-10-08-tsmc-monthly",     // 一意。日付-短い英字スラッグ
  "d": "2026-10-08",                    // 日本時間の日付
  "t": "14:30",                         // 日本時間 HH:MM。不明なら省略。24時超えは翌日の日付で書く
  "approx": true,                       // 時刻が「頃」なら true
  "country": "TW",                      // JP / US / TW / CN / EU / KR / GLOBAL
  "title": "TSMC 月次売上高（9月）",
  "desc": "世界の半導体需要を占う注目材料",   // 25文字前後の一行説明
  "impact": 2,                          // 1〜3（下記）
  "themes": ["semi", "ai"],            // data/themes.json の id。全体相場なら []
  "tentative": false,                   // 日程未確定・推定なら true
  "src": "https://...",                 // 根拠 URL（任意だが推奨）
  "code": "9983",                       // 国内企業の決算なら銘柄コード（任意）。JPX由来の決算行と統合される
  "ticker": "NVDA"                      // 海外企業の決算なら Yahoo Finance のティッカー（任意）。反応チャートに使う
}
```

## 影響度（impact）の基準
- **3（★★★ 相場全体が動く）**: 米雇用統計、米CPI、FOMC結果、日銀会合結果、NVIDIA決算、ジャクソンホール議長講演、メジャーSQ、米大統領・FRB議長の重大発言
- **2（★★ セクター・テーマが動く）**: ISM、PCE、米GDP、小売売上、PPI、FOMC議事要旨、TSMC月次・決算、ASML/マイクロン/ブロードコム決算、米メガテック決算、日銀総裁講演、短観、中国GDP、ECB、工作機械受注
- **1（★ 参考）**: 景気動向指数、景気ウォッチャー、国際収支、貿易収支、ミシガン大、機械受注、その他

迷ったら低い方に倒す。★3 を乱発すると意味がなくなる。

## テーマ（themes）の付け方
影響を受ける日本株テーマを `data/themes.json` の id で付ける。例:
- テーマ id 一覧は data/themes.json（31テーマ）。細分化テーマ（semiequip 半導体製造装置 / semimat 半導体材料 / physai フィジカルAI / datacenter / quantum / space / autodrive / shipbuild / rareearth / regbank / kokudo / cyber / perovskite / highdiv）も積極的に使う
- TSMC月次・マイクロン・ASML → `semi`, `semiequip`
- NVIDIA → `semi`, `ai`, `datacenter`, `wire`
- 日銀 → `bank`, `realestate`
- 工作機械受注 → `machine`
- 中国 PMI/GDP → `steel`, `machine`, `ship`
- 米CPI・雇用統計・FOMC → `[]`（全体）

## 予定外ニュース（news.json）
株価を目に見えて動かした「予定されていなかった」出来事。アプリの「ニュース」タブに新しい順で並び、反応日・1週間後・1か月後の騰落率（日経平均・S&P500・SOX・関連テーマ主力株・関連銘柄）が自動で付く。
- 入れるもの: AI企業の巨額損失・投資計画（例: OpenAI の巨額損失報道→半導体急落）、関税発表、地政学ショック、要人の予定外発言、政策サプライズ、為替介入、大型M&A、不祥事 など
- 入れないもの: 予定された指標・会合・決算そのもの（events.json 側）。結果がサプライズでも events.json の desc に書く
- src（実際に開いた記事URL）必須。裏付けの取れないものは入れない。同じ出来事の重複は避ける
- `d` は日本時間で市場に伝わった日。米国時間の夜に出たものは日本時間の翌日になることが多い。`t` は分かれば日本時間で（不明なら省略＝その日の場中に伝わった扱い）

```json
{
  "id": "2026-09-xx-openai-loss",       // 日付-短い英字スラッグ
  "d": "2026-09-xx", "t": "06:30", "approx": true,
  "country": "US",                       // JP / US / TW / CN / EU / KR / GLOBAL
  "cat": "AI・半導体",                   // 要人発言 / 関税・貿易 / 地政学 / 企業 / AI・半導体 / 金融・市場 / 政治 / その他
  "title": "30文字以内の見出し",
  "desc": "60文字前後: 何が起きて市場がどう反応したか",
  "impact": 2,                           // 3=相場全体（日経±2%級）/ 2=セクター / 1=小
  "themes": ["semi", "ai"],             // themes.json の id
  "codes": ["9984"],                     // 直撃した日本株の銘柄コード（任意）
  "tickers": ["NVDA"],                   // 直撃した海外銘柄の Yahoo ティッカー（任意、指数は不可）
  "src": "https://..."
}
```

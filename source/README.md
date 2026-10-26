# 紅華祭 整理券 — 持ち運び版のソース

通常の利用ではソースのビルドやライブラリーのインストールは不要です。
親フォルダーの「起動.bat」「来場者受付用に起動.bat」を使ってください。

## 構成

- frontend/main.tsx：画面の切り替え（`#/` 来場者、`#/ticket` 整理券、`#/admin` 運営）。
- frontend/visitor.tsx：来場者画面。回の一覧、人数選択、整理券の表示と取消。
- frontend/admin.tsx：運営画面。回の管理、一時停止、整理券の一覧と取消、集計・CSV、掲示用QR。
- frontend/content.ts：来場者画面と掲示物の文言（集合場所などの注意事項）。
- frontend/globals.css：チケット会計アプリと共通の画面デザイン。
- frontend/seiriken.css：整理券アプリ固有のデザイン。
- backend/server.mjs：Node標準HTTPサーバー。`--lan` で同じWi-Fiのスマホに公開。
- backend/lib/seiriken-service.mjs：発行・取消・回の管理・状態の計算・CSV。
- backend/storage.mjs：Node標準SQLite、DB初期作成、トランザクション、ファイルバックアップ。
- backend/control.mjs：このフォルダーのサーバーの正常停止。
- backend/schema.sql：表の定義。番号の重複、端末ごとの重複、整理券の削除・改変を拒否。
- tests/：HTTP経由の検証（受付時間、定員、取消、同時400件、再起動、スタッフコード）。
- frontend/lib/backend.ts：画面からのデータの呼び出し口。Wi-Fi版は `/api/...` を呼ぶ。
- frontend/lib/backend-supabase.ts：Supabase版の呼び出し（`supabase/migrations/001_init.sql` の関数）。
- build-online.mjs / preview-online.mjs：Supabase版のビルドと、このPCで試すための簡易サーバー。
- tests/supabase-sql.test.mjs：Supabase版のSQLを埋め込みPostgres（PGlite）で検証。
- tests/online-smoke.mjs：本物のSupabaseプロジェクトに対する動作確認（200件同時を含む）。

## しくみの要点

- 状態（受付前／受付中／満員／一時停止中／受付終了／終了した回）は保存せず、
  PCの現在時刻・残り人数・一時停止の有無から毎回計算します。
- 発行は `BEGIN IMMEDIATE` のトランザクション内で、受付時間・残り人数・
  端末ごとの重複を確認してから「その回の最大番号＋1」を採番します。
  node:sqlite は同期処理なので、同時の申し込みが割り込むことはありません。
- 来場者のスマホには、端末ID・整理券ID・取消用の合言葉（token）を localStorage に保存します。
  送信番号（requestId）を再送しても二重に発行しません。
- 運営APIは、整理券PC本体（127.0.0.1）からは認証なし、
  他の端末からはスタッフコードで発行したCookieが必要です。

## 修正する場合

Node.js 24とnpmが利用できる開発環境で、このsourceフォルダーへ移動します。

```
npm install
npm run build
```

`npm run build` は親フォルダーの app/ を更新します。
このフォルダーがネットワークドライブにあって npm install が遅い場合は、
source をローカルにコピーしてビルドし、出力先を環境変数で指定できます。

```
set SEIRIKEN_OUTPUT=Z:\...\koukasai_seiriken
node build-portable.mjs
```

型検査は `npm run typecheck` です。

## Supabase版（Wi-Fi不要）

同じ画面を `--mode online` でビルドすると、Supabase をデータの置き場所にした静的サイトが親フォルダーの online/ にできます。
準備（プロジェクト作成・SQLの実行・スタッフのアカウント）は `../supabase/README.md` を見てください。

```
copy .env.online.example .env.online   （Supabase の URL と anon key を書く）
npm run build:online                   （online/ を作る）
npm run preview:online                 （http://127.0.0.1:8767 で試す）
npm run dev:online                     （開発用サーバー）
```

Supabase のライブラリーは Supabase版のビルドにだけ入り、Wi-Fi版（app/public）には入りません。

配布済みのDBに適用する際は、既存のschema.sqlを勝手に書き換えず、
追加のマイグレーションを設計してください。現版は定義が変わると安全のため起動を停止します。

## テスト

親フォルダーの runtime/node.exe で、sourceを作業フォルダーにして実行できます。
テスト用のDBは一時フォルダーに作られ、本番のdataは変更しません。

```
..\runtime\node.exe --test tests/seiriken-http.test.mjs
```

Supabase版のSQLの検証は `npm install` のあと `npm run test:sql`（Supabase のアカウントは不要）。

## 元にしたもの

チケット会計アプリ（koukasai_ticket）の持ち運び版の構成
（runtime 同梱、node:http + node:sqlite、起動・停止スクリプト、自動バックアップ）を流用しています。

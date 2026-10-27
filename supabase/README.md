# Supabase版（Wi-Fi不要）の準備

Supabase版は、整理券のデータをインターネット上のデータベース（Supabase）に置く方式です。
来場者は自分のスマホの電波（4G/5G）でも、どのWi-Fiからでも整理券を取れます。
整理券PCを会場に置いておく必要もありません。

画面と整理券のルール（受付時間・定員・1端末1枚・取消・番号）は、Wi-Fi版と同じです。
Wi-Fi版（「起動.bat」「来場者受付用に起動.bat」）はそのまま残っていて、いつでも使えます。

| | Wi-Fi版 | Supabase版 |
|---|---|---|
| データの置き場所 | 整理券PC（`data/seiriken.sqlite3`） | Supabase（インターネット上） |
| 来場者のつなぎ方 | 整理券PCと同じWi-Fi | インターネットにつながれば何でもよい |
| 必要なもの | ノートPC・モバイルルーター | Supabaseのアカウント・公開先（静的サイトのホスティング） |
| 運営画面に入る方法 | PC本体はそのまま、他の端末は8桁のスタッフコード | メールアドレスとパスワード |
| バックアップ | 自動（`backups/`） | Supabaseに保存。終わったらCSVで手元に残す |
| 事前の準備 | なし | この README の手順（初回30分ほど） |

## 1. Supabase のプロジェクトを作る

1. https://supabase.com でアカウントを作り、「New project」を押します。
2. 名前（例: `koukasai-seiriken`）、データベースのパスワード（自分で決めて控える）、
   Region は「Northeast Asia (Tokyo)」を選んで作成します。無料プラン（Free）で足ります。
3. 作成が終わるまで数分待ちます。

## 2. データベースを作る（SQLを1回だけ実行）

1. 左のメニューの「SQL Editor」を開き、新しいクエリを作ります。
2. このフォルダーの `migrations/001_init.sql` をメモ帳で開き、全文をコピーして貼り付けます。
3. 「Run」を押します。「Success. No rows returned」と出れば完了です。

2回実行すると「already exists」のエラーになります（1回目の内容はそのまま残っています）。

続けて同じ手順で、次の4つを順に実行します。

- `migrations/002_children.sql`：子どもの区分と保護者の人数を記録する追加分
- `migrations/003_name.sql`：申し込んだ人の名前を記録する追加分（004 で名前は消えます）
- `migrations/004_checkin.sql`：入場受付（QRコード）の追加と、名前の廃止
- `migrations/005_events_waitlist.sql`：イベント（会場・ご案内）、回の上演時間、
  時間が重なる回の整理券を同じスマホで持てないしくみ、キャンセル待ち（自動で繰り上げ発行）

番号の順に、それぞれ1回だけ実行してください。

### すでに運用していて、途中までしか実行していない場合

1. SQL Editor で、まだ実行していない番号のファイルを、小さい番号から順に1回ずつ実行します。
   001 だけなら 002 → 003 → 004 → 005、003 まで済んでいるなら 004 → 005、004 まで済んでいるなら 005 だけです。
   004 までは、これまでの整理券はそのまま残ります（区分・保護者は0として扱われ、受付用のQRコードも自動で付きます）。
   004 を実行すると、記録してあった名前はすべて消えます（元に戻せません）。
   **005 を実行すると、登録してあった回と整理券はすべて消えます**（リハーサルのデータを消す前提です。元に戻せません）。
   本番の整理券が入っているときは、005 を実行しないでください。
2. **すぐに** 画面を作り直して公開します（親フォルダーの `publish.bat` をダブルクリック）。
   SQLを実行すると古い画面からは整理券を取れなくなり、新しい画面はSQLがないと整理券を取れません。
   受付をしていない時間に、続けて行ってください。
3. 005 を実行したあとは、運営画面の「イベントと回」で、イベントと回を登録し直します。

## 3. 運営スタッフのアカウントを作る

ログインできる人は全員、運営スタッフとして扱います。必ず次の両方を行ってください。

1. 「Authentication」→「Users」→「Add user」→「Create new user」で、
   スタッフ用のメールアドレスとパスワードを入れ、「Auto Confirm User」にチェックして作成します。
   スタッフ全員で1つのアカウントを共有しても、1人ずつ作ってもかまいません。
2. 「Authentication」の設定（Sign In / Providers など）で、
   **「Allow new users to sign up」をオフ**にします。
   オンのままだと、誰でもアカウントを作って運営画面に入れてしまいます。

## 4. 接続先を書く（`source/.env.online`）

1. 「Project Settings」→「API」（または「API Keys」「Data API」）を開きます。
2. 次の2つを控えます。
   - Project URL（`https://xxxx.supabase.co`）
   - anon public key（新しい画面では publishable key `sb_publishable_...` でもかまいません）
3. `source/.env.online.example` をコピーして `source/.env.online` という名前にし、2つの値を書き込みます。

anon key / publishable key は来場者のスマホにも届く「公開してよい鍵」です。
データは関数を通してしか読み書きできないように作ってあります（表を直接読むことはできません）。
**service_role key（secret key）は絶対に書かないでください。**

`source/.env.online` は `.gitignore` に入れてあり、Gitには入りません。

## 5. オンライン版をビルドする

画面を作るときだけ Node.js 24（npm付き）が必要です。`source` フォルダーで次を実行します。

```
npm install
npm run build:online
```

親フォルダーに `online/` ができます。これがオンライン版の画面一式（静的なファイルだけ）です。
`.env.online` を書き換えたときは、もう一度 `npm run build:online` を実行してください。

フォルダーがネットワークドライブにあって遅い場合は、Wi-Fi版と同じく `source` をローカルにコピーし、
`set SEIRIKEN_OUTPUT=Z:\...\koukasai_seiriken` を指定してから `node build-online.mjs` を実行できます。

## 6. このPCで試す

親フォルダーの「オンライン版を試す.bat」をダブルクリックします。
ブラウザーで運営画面（`http://127.0.0.1:8767/#/admin`）が開きます。

1. 手順3のメールアドレスとパスワードでログインします。
2. 「イベントと回」で開催日・イベント・回を登録します。
3. 「来場者向けの画面を開く」から、整理券を取って表示・取消できることを確かめます。

この試用サーバーはこのPCの中だけで動くので、スマホからは開けません。
データは本物の Supabase に保存されます。

## 7. 来場者に公開する（このリポジトリでは未設定）

`online/` フォルダーの中身を、静的サイトを置けるサービス（GitHub Pages、Cloudflare Pages、Netlify など）に
そのままアップロードすると、来場者が開けるURLになります。どのURLの下に置いても動くように作ってあります。

公開したら、そのURLの `#/admin` で運営画面を開き、「掲示用QR」を印刷します。
QRコードには、いま開いているページのURLがそのまま入ります。

## 8. 動作確認（任意）

本物の Supabase に対して、発行・再送・1端末1枚・取消・200件同時の申し込み・入場受付・キャンセル待ちの繰り上げを確かめるスクリプトがあります。
「自動確認」というイベントと回を1つずつ作って最後に一時停止します（発行した回は削除できないため残ります）。
本番の回を登録する前に実行してください。開催日を今日にしておく必要があります。

```
cd source
set SEIRIKEN_STAFF_EMAIL=スタッフのメールアドレス
set SEIRIKEN_STAFF_PASSWORD=パスワード
..\runtime\node.exe tests\online-smoke.mjs
```

SQLだけなら Supabase なしでも確かめられます（埋め込みのPostgresで実行します）：
`npm install` のあと `npm run test:sql`。

## 本番前の注意

- 無料プランのプロジェクトは、1週間ほど使わないと一時停止されます。
  本番の数日前と前日に Supabase の画面を開き、停止していたら「Restore」で戻してください。
- リハーサルで取った整理券を全部消して本番を迎えたい場合は、SQL Editor で次を実行します。
  回・整理券・キャンセル待ちがすべて消えます（イベントは残ります。元に戻せません）。

  ```sql
  truncate public.waitlist, public.tickets, public.operations, public.rounds restart identity;
  ```

  イベントもまとめて消す場合は、かわりに次を実行します。

  ```sql
  truncate public.waitlist, public.tickets, public.operations, public.rounds, public.events restart identity;
  ```

- 終了後は運営画面の「集計・出力」から CSV を出力して、手元に残してください。

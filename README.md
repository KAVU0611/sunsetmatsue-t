# Sunset Forecast (Stability Edition)

Stability AI Stable Image (SD3) を既定プロバイダに採用し、嫁ヶ島ビューの夕景カードを生成して S3/CloudFront へ自動保存する “本番手前” パイプラインです。React (Vite) フロントエンド → API Gateway → Lambda (Python 3.12) → Stability AI（必要に応じて AWS Bedrock Titan へフォールバック）→ S3 → CloudFront という経路を CDK(TypeScript) で構築し、Route 53 Hosted Zone 作成と GitHub Actions 自動化まで含めています。

> Bedrock Titan は失敗時のフォールバックとして維持しているため、必要なら `IMG_PROVIDER=titan` で切り替え可能です。

## リポジトリ構成

| パス | 説明 |
| --- | --- |
| `frontend/` | Vite + React + Tailwind + shadcn/ui。日付/場所/天候を入力して生成結果をグリッド表示します。|
| `services/lambda/generate-card/` | Stability AI (SD3) をメインに呼び出し、必要に応じて Bedrock Titan v1 へフォールバックしながらカード画像を生成し、Pillow でテキストを重ねて S3 に保存します。|
| `layers/pillow/` | Lambda Layer (Pillow) のビルドスクリプト。manylinux wheel を取得して `pillow-layer.zip` を生成します。|
| `infra/cdk/` | CDK アプリ。S3(画像), CloudFront(OAC), API Gateway, Lambda, Lambda Layer, IAM、Route 53 Hosted Zone の IaC。|
| `.github/workflows/*.yml` | `deploy.yml` (pnpm + CDK)、`frontend-build.yml` (pnpm + S3 sync) に加えて、OIDC AssumeRole で動く `cdk-deploy.yml` / `frontend-build-deploy.yml` を用意しています。|
| `Makefile` | `make bootstrap / deploy / destroy` で CDK 操作を共通化します。|

## 事前準備

- Node.js 20 / pnpm 9
- Python 3.12 (ローカルで layer をビルドする場合)
- AWS CLI v2 / CDK v2 (`npm i -g aws-cdk`)
- Stability AI API キー（SSM パラメータストア等に格納）
- Bedrock Titan Image Generator v1 へのアクセス権 (us-east-1、フォールバック用)
- Route 53 で委譲できる独自ドメイン (`MY_DOMAIN_NAME`) ※最終レコード追加は手動

## 環境変数とシークレット

| 変数 | 用途 |
| --- | --- |
| `IMG_PROVIDER` | 既定は `stability`。`titan` を指定すると Bedrock のみを使用。|
| `STABILITY_API_KEY_PARAM` | Stability API キーの SSM パラメータ名。既定は `/sunset/STABILITY_API_KEY`。|
| `STABILITY_ENDPOINT` | Stability API エンドポイント。既定は `https://api.stability.ai/v2beta/stable-image/generate/sd3`。|
| `STABILITY_MODEL` | Stability 側のモデル名。既定は `sd3`。|
| `STABILITY_WIDTH` / `STABILITY_HEIGHT` | Stability 生成時の解像度 (64px の倍数)。既定は `1344x768`。|
| `MODEL_ID` | Titan フォールバック用モデル ID。既定は `amazon.titan-image-generator-v1`。|
| `BEDROCK_REGION` | Bedrock 呼び出しリージョン。Titan v1 は us-east-1 を推奨。|
| `FRONTEND_ORIGIN` | CORS 許可オリジン。`matsuesunsetai.com` を使う場合は `https://matsuesunsetai.com` を指定 (Stack 側で `https://www.matsuesunsetai.com` も自動許可)。未指定なら `https://<MY_DOMAIN_NAME>` が既定。|
| `MY_DOMAIN_NAME` | Route 53 Hosted Zone を作成するドメイン (例: `example.com`)。|
| `FRONTEND_DEPLOY_BUCKET` / `FRONTEND_DISTRIBUTION_ID` | GitHub Actions (`frontend-build.yml`) で使用する静的ホスティング先。|
| `FRONTEND_API_URL` | Vite ビルド時に埋め込む API Gateway の `/generate-card` フル URL。|
| `DEPLOY_ROLE_ARN` | GitHub Actions から Assume する IAM ロール ARN。|

GitHub Secrets に格納し、必要に応じてワークフローや `pnpm run cdk ...` 実行時にエクスポートしてください。

## セットアップ手順

1. 依存関係をインストール
   ```bash
   pnpm install
   ```
2. フロントエンドの環境変数雛形をコピー
   ```bash
   cp frontend/.env.example frontend/.env
   # VITE_API_URL=https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/generate-card を設定
   ```
3. （任意）Pillow Layer をローカルで事前ビルド
   ```bash
   bash layers/pillow/build.sh
   # dist/pillow-layer.zip が生成されます。CDK Bundling でも自動生成されるため任意です。
   ```
4. CDK ブートストラップ & デプロイ
   ```bash
   export IMG_PROVIDER=stability
   export STABILITY_API_KEY_PARAM=/sunset/STABILITY_API_KEY
   export MODEL_ID=amazon.titan-image-generator-v1
   export BEDROCK_REGION=us-east-1
   export FRONTEND_ORIGIN=https://matsuesunsetai.com
   export MY_DOMAIN_NAME=matsuesunsetai.com

   make bootstrap   # 初回のみ
   make deploy
   ```
   Stability API キーは `STABILITY_API_KEY_PARAM` で指定した SSM パラメータ (SecureString) に保存しておきます。
   デプロイ完了後、`CloudFrontDomain`, `ImagesBucketName`, `HostedZoneId` などの出力を控えます。

## フロントエンド開発

```bash
cd frontend
pnpm dev   # http://localhost:5173
```

UI ではフォーム送信→生成中スピナー→生成結果グリッド表示を確認できます。`VITE_API_URL` を未設定の場合はエラーアラートが表示されます。

## GitHub Actions

- `.github/workflows/deploy.yml`
  - 変更検知 (`infra/**`, `services/lambda/**`, `layers/**`) で起動。
  - `pnpm install` → `cdk synth` → `cdk diff` → `cdk deploy`。
  - `MODEL_ID / FRONTEND_ORIGIN / MY_DOMAIN_NAME` は Secrets 経由で上書き。
- `.github/workflows/frontend-build.yml`
  - `frontend/**` 更新時または手動実行。
  - `pnpm --filter sunset-forecast-frontend build` → `aws s3 sync frontend/dist ...`。
  - `FRONTEND_DEPLOY_BUCKET`, `FRONTEND_DISTRIBUTION_ID`, `FRONTEND_API_URL`, `DEPLOY_ROLE_ARN` を Secrets で指定してください。
- `.github/workflows/cdk-deploy.yml`
  - GitHub OIDC + `aws-actions/configure-aws-credentials@v4` で IAM Role を Assume。
  - Node.js 20 / `npm ci` / `npx cdk synth → bootstrap → deploy --require-approval never` を us-east-1 既定で実行します。
- `.github/workflows/frontend-build-deploy.yml`
  - Vite ビルド前に Secrets をガードし、`frontend`（またはルート）ディレクトリを自動検出。
  - `dist/` を S3 にキャッシュ制御付きで配置し、`index.html` と `/assets/*` を CloudFront で無効化します。

## OIDC + Secrets 自動セットアップ

`scripts/setup-oidc-and-secrets.sh` で以下を自動化できます。

- `fix/gha-oidc-ci` ブランチ/PR の作成と最新テンプレートの維持
- GitHub OIDC Provider / `GitHubActionsOIDC` ロールの作成・更新（AdministratorAccess 付与のうえ Trust Policy を `repo:KAVU0611/sunsetmatsue-t:ref:refs/heads/main` に限定）。`scripts/iam-trust-policy-example.json` を `aws iam update-assume-role-policy` に渡すだけで更新可能です。
- CloudFront / S3 / VITE_API_URL 値の自動検出（見つからなければ対話入力）
- `AWS_ROLE_TO_ASSUME`, `AWS_REGION`, `S3_BUCKET_NAME`, `DISTRIBUTION_ID`, `VITE_API_URL` の GitHub Secrets 設定と検証
- `CDK Deploy` / `Frontend Build & Deploy` の実行 → PR オートマージ → main での再実行

事前に `aws`, `gh`, `jq`, `git` が利用可能で、`aws-cli` / `gh-cli` が認証済みであることを確認してください。実行例:

```bash
chmod +x scripts/setup-oidc-and-secrets.sh
./scripts/setup-oidc-and-secrets.sh
```

完了後は ROLE ARN や Secrets 値、main の最新 SHA、失敗時の確認ポイントがサマリで表示されます。

## 必要な GitHub Secrets 一覧

| Secret | 説明 |
| --- | --- |
| `AWS_ROLE_TO_ASSUME` | GitHub Actions から Assume する IAM ロール ARN。 |
| `AWS_REGION` | 既定は `us-east-1`（CDK/Bedrock 用）。別リージョンを使う場合はここで指定します。 |
| `S3_BUCKET_NAME` | フロントエンドを配置する静的サイト用 S3 バケット名。 |
| `DISTRIBUTION_ID` | 配信中の CloudFront Distribution ID。 |
| `VITE_API_URL` | フロントビルドで埋め込む API Gateway の完全 URL。 |

> **NOTE:** GitHub Actions では暫定的に `https://3s9sgxfexe.execute-api.us-east-1.amazonaws.com/prod` をフォールバック値として使用します。本番環境に合わせたい場合は必ず `VITE_API_URL` シークレットを設定してください。

## Route 53 ドメイン手順

CDK が Hosted Zone / us-east-1 ACM 証明書 / matsuesunsetai.com 用の A・AAAA (ALIAS) / www CNAME をすべて作成します。利用者が行うのは以下のみです。
1. ドメインレジストラ (Route 53 Domains など) に、出力された `HostedZoneNameServers` を NS レコードとして登録。
2. 伝播完了後、CloudFront のカスタムドメインに `matsuesunsetai.com` / `www.matsuesunsetai.com` が自動でバインドされていることを確認。

## matsuesunsetai.com 統合クイックスタート

1. ルートディレクトリで環境変数をセット。
   ```bash
   export MY_DOMAIN_NAME=matsuesunsetai.com
   export FRONTEND_ORIGIN=https://matsuesunsetai.com
   export MODEL_ID=amazon.titan-image-generator-v1
   export BEDROCK_REGION=us-east-1
   ```
2. CDK をデプロイ。
   ```bash
   make deploy
   ```
   `ApiUrl`, `CloudFrontDomain`, `HostedZoneNameServers` を控え、NS が伝播するまで待ちます。
3. フロントエンド環境変数を更新。
   ```bash
   cd frontend
   cp .env.example .env  # 未作成の場合
   echo "VITE_API_URL=<ApiUrlを貼り付け>" > .env
   pnpm install
   pnpm build
   ```
4. ビルド成果物を既存の静的ホスティング先へ配置 (GitHub Actions でも可)。手動で行う場合は以下を目安にしてください。
   ```bash
   export FRONTEND_DEPLOY_BUCKET=<静的ホスティング用S3>
   export FRONTEND_DISTRIBUTION_ID=<フロントエンド用CloudFront>
   aws s3 sync frontend/dist s3://$FRONTEND_DEPLOY_BUCKET --delete
   aws cloudfront create-invalidation --distribution-id $FRONTEND_DISTRIBUTION_ID --paths '/*'
   ```
5. ブラウザで `https://matsuesunsetai.com` / `https://www.matsuesunsetai.com` を開き、アプリ→API→Lambda→Bedrock→S3/CloudFront の流れと `images/*` のレスポンスを確認します。

## Lambda / API の挙動

- 環境変数: `MODEL_ID`, `BEDROCK_REGION`, `OUTPUT_BUCKET`, `CLOUDFRONT_DOMAIN`, `ALLOWED_ORIGINS`。
- CORS: `ALLOWED_ORIGINS` (カンマ区切り) に一致するオリジンのみ許可。未指定時 `*`。
- ログ: CloudWatch Logs に JSON で `event`, `requestId`, `errorType` などを出力。
- 座標は「嫁ヶ島ビュー（35.4690, 133.0505）」に固定し、クライアントから渡された lat/lon は Lambda 内で無視します。
- Astral (Python) で JST の日の入りを算出し、画像右下へ `Sunset HH:MM JST` を描画、さらに API レスポンスへ `sunsetJst` を追加してフロントでも表示します。

### 予報 API (`/forecast/sunset`)

- `GET /forecast/sunset?date=YYYY-MM-DD`
  - `date` は任意。指定しない場合は当日 (JST) の予報を返します。
  - Open-Meteo Air Quality API を使って `雲量 / 湿度 / PM2.5` を 1 時間解像度で取得し、日の入り時刻に最も近い値を返却します。
  - レスポンス例:
    ```json
    {
      "location": { "lat": 35.4727, "lon": 133.0505 },
      "sunset_jst": "2025-11-09T17:00:00+09:00",
      "source": "open-meteo",
      "predicted": {
        "cloudCover_pct": 42,
        "humidity_pct": 68,
        "pm25_ugm3": 7.4
      },
      "hourly_timestamp": "2025-11-09T17:00:00+09:00",
      "cache_ttl_sec": 3600
    }
    ```
- `Cache-Control: public, max-age=3600` を付与しているため、CloudFront / ブラウザ経由で 1 時間キャッシュされます (API Gateway ステージでの追加キャッシュ設定と併用可)。

### 正常系テスト

1. CDK デプロイ後、Rest API URL (`.../prod/`) を確認。
2. `curl` で `/generate-card` を叩く:
   ```bash
   API=https://xxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/generate-card
   curl -X POST "$API" \
     -H 'Content-Type: application/json' \
     -d '{"location":"Matsue","date":"2025-11-07","style":"sunset poster","conditions":"clear sky"}'
   ```
   - 200 応答には `requestId`, `objectKey`, `s3Url`, `cloudFrontUrl` (CloudFront 有効時) が含まれます。
   - `cloudFrontUrl` をブラウザで開き、OAC 経由で画像が取得できることを確認します。
3. フロントエンド (`pnpm dev`) から同じデータでリクエストし、生成カードがグリッド表示されることを確認します。

### CloudFront 経由確認

- `cloudFrontUrl` が `https://<distribution>/images/...jpg` であること。
- 直接 `s3.amazonaws.com` を開くと AccessDenied になる (OAC 強制) こと。

### 失敗ケース再現 & ログ確認

1. **Bedrock モデル未許可**: `MODEL_ID` に許可されていない ID を設定して `make deploy`。`curl` リクエストすると 500 応答 + `errorType: InternalError`。CloudWatch Logs (Lambda グループ) に `request.failed` と `Bedrock invoke failed` が JSON で記録されます。
2. **S3 権限不足**: 一時的に Lambda IAM の `s3:PutObject` をコメントアウトして `cdk deploy` すると、API は 500 と `Image generation failed` を返します。CloudWatch Logs には `AccessDenied` が出力されます。権限を戻した後に再デプロイしてください。

## Makefile コマンド

```bash
make bootstrap   # pnpm install + cdk bootstrap
make deploy      # pnpm install + cdk deploy --require-approval never
make destroy     # リソース削除 (S3 は RETAIN のため手動削除が必要)
```

## Pillow Layer

`layers/pillow/build.sh` では以下を実行します。
1. manylinux2014_x86_64 / Python3.12 用 Pillow wheel をダウンロード。
2. Lambda 互換ディレクトリ (`python/lib/python3.12/site-packages`) に展開。
3. `pillow-layer.zip` を出力。

CDK bundling でも同等の処理を行うため、CI では追加作業不要です。

## モニタリングとログ

- API Gateway: `ApiAccessLogs` (JSON) に構造化アクセスログ。
- Lambda: `request.received / request.completed / request.failed` を JSON 出力。
- CloudFront: OAC + キャッシュポリシー `CACHING_OPTIMIZED` を利用。Invalidation は GitHub Actions または `aws cloudfront create-invalidation` で実行。

## トラブルシューティング

- `No module named 'PIL'`: Pillow は Lambda Layer によって提供されるため、`layers/pillow/build.sh` が改善済みです。CDK Bundling で自動添付されます。
- `AccessDenied` (S3): OAC 以外からのアクセスは禁止。CloudFront の Distribution ID を bucket policy に反映するため、必ず CDK を通して管理してください。
- Hosted Zone の NS 未反映: レジストラ側の NS レコード更新後、最大 48 時間伝播が必要です。伝播完了までは CloudFront カスタムドメインを追加しないでください。

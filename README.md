# NexProxy — 高性能 Web プロキシ

CroxyProxy を参考にした高性能な Web プロキシです。Render に無料でデプロイできます。

## 機能

- **HTML URL 書き換え** — すべてのリンク・画像・スクリプトを自動リライト
- **CSS URL 書き換え** — `url()` 参照を自動プロキシ化
- **JavaScript フック** — `fetch` / `XHR` をオーバーライドして AJAX リクエストもプロキシ経由に
- **フォーム送信** — GET/POST フォームをインターセプトしてプロキシ転送
- **文字コード自動検出** — `iconv-lite` で Shift-JIS / EUC-JP なども対応
- **圧縮対応** — gzip / brotli 自動解凍 & 再圧縮
- **セキュリティ** — プライベート IP ブロック、ホップヘッダ除去、CSP 無効化
- **タイムアウト保護** — 30秒でフォールバック
- **リダイレクト追跡** — 最大 10 ホップまで自動追跡

## Render へのデプロイ手順

### 1. GitHub にプッシュ

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/あなたのユーザー名/nexproxy.git
git push -u origin main
```

### 2. Render でデプロイ

1. [render.com](https://render.com) にログイン
2. "New +" → "Web Service"
3. GitHub リポジトリを選択
4. 設定:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. "Create Web Service" をクリック

### 3. 自動デプロイ

`render.yaml` が含まれているので、"New +" → "Blueprint" からもデプロイ可能です。

## ローカル実行

```bash
npm install
npm start
# → http://localhost:3000
```

## プロキシ URL の形式

```
https://あなたのサービス名.onrender.com/proxy?url=https://example.com
```

## 注意事項

- このプロキシは個人・教育目的のみに使用してください
- 著作権や利用規約を遵守してください
- 本番環境では認証機能の追加を推奨します

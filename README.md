# Science
## 軽量で高速、便利なwebプロキシです

```
npm install
npm start
```

`http://localhost:3000` を開いて使います。Node.js 18 以上が必要です。

### 主な機能
- フォーム送信・ファイルアップロード・ログインの cookie に対応 (cookie はサイトごとに分離)
- Shift_JIS / EUC-JP などのサイトも文字化けせずに表示
- 動画のシーク (Range リクエスト) やファイルのストリーミング転送
- WebSocket のプロキシ
- ページの JS が行う通信 (fetch / XHR / WebSocket / ページ移動など) を自動でプロキシ経由に変換
- Service Worker によるプロキシ外へのリクエストの取りこぼし防止
- サーバー内部・ローカルネットワークへのアクセスをブロック (SSRF 対策)

### 環境変数
| 名前 | 説明 | 既定値 |
| --- | --- | --- |
| `PORT` | 待ち受けポート | `3000` |
| `UPSTREAM_TIMEOUT_MS` | 接続先サイトの応答待ち時間 (ミリ秒) | `30000` |
| `ALLOW_PRIVATE_NETWORK` | `1` でローカル/社内ネットワークへのアクセスを許可 (非推奨) | 無効 |

※ `npm start` を使わずに起動する場合は `node --max-http-header-size=81920 index.js` としてください (YouTube などヘッダーが大きいサイト用)。

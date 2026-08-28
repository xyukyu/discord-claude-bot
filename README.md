# discord-claude-bot

Claude Code で応答する Discord bot。**依存パッケージゼロ**（Node 22+ の組み込み
`fetch` / `WebSocket` のみ）で、Anthropic API キーも不要です。

Claude Code のサブスクリプションをそのまま使い、常駐プロセスが Gateway 接続を
保持して、メンションに即時返信します。

## できること

**メンションへのリアルタイム返信**
`@bot名` で話しかけるか、bot の発言に返信すると応答します。直近の会話を読むので
文脈が続きます。

**ステータス（プレゼンス）表示**
20秒ごとに表示を切り替えます。

```
たろうと9回やり取りしたにゅ。
ロピアのチーズタッカルビの話がまだ続いてるにゅ   ← Claude が生成
今までの累計やり取りは13回だにゅ。
```

**週間レポート**
毎週日曜21時に、その週の統計と振り返りを Embed で投稿します。
出来事の羅列ではなく、bot 自身の一人称の振り返りと「今週の気づき」を書きます。

**CLI**
読み書き・集計・Embed 投稿を単体で叩けます。

```bash
node discord.js channels                       # サーバー/チャンネルとID一覧
node discord.js read <channelId> --limit 30    # 直近メッセージ
node discord.js stats <channelId> --days 7     # 投稿数・返信回数・人別件数
node discord.js transcript <channelId> --days 7  # 会話ログ
node discord.js reply <channelId> <messageId> 本文
node discord.js embed <channelId> <jsonファイル>
```

## 構成

```
【常駐】 bot.js  ← Gateway (WebSocket)
    ├─ MESSAGE_CREATE 受信 → Claude Code で返信を生成 → 投稿
    ├─ 20秒ごとにプレゼンスを切り替え
    ├─ 接続確立のたびに切断中の取りこぼしを回収
    └─ 切断時は指数バックオフで再接続（RESUME 優先）

【毎分】      guard.ps1       bot.js の死活監視・再起動
【毎時】      impression.ps1  プレゼンス用の所感を生成
【毎週日21時】 weekly.ps1      週間レポートを Embed で投稿
```

## 動作環境

- **Windows 10/11 + Windows PowerShell 5.1**
  常駐・定期実行はタスクスケジューラ前提です。`discord.js` の CLI 部分だけなら
  他OSでも動きます
- **Node.js 22 以上**（組み込み `WebSocket` を使うため）
- **Claude Code CLI**

## セットアップ

[SETUP.md](SETUP.md) に、bot の作成からタスク登録まで手順があります。所要20〜30分。

必要な Discord の設定は2つだけです。

- **MESSAGE CONTENT インテント**の有効化（本文の受信に必須）
- 権限 `68672`（View Channel / Send Messages / Add Reactions / Read Message History）

## 設計メモ

**プレゼンスは REST では設定できません。** WebSocket 接続が生きている間だけ存在する
揮発的な状態なので、常駐プロセスが必須です。逆に単発の読み書き・集計は REST で足りるため、
CLI (`discord.js`) は REST のみで書いてあります。

**ポーリングは完全には捨てていません。** Gateway だけだと切断中のメッセージを
取りこぼすため、`poll` / `ack` / `state.json` を接続確立時の回収用に残しています。
定期ポーリングはしないので、常時の API 負荷はゼロです。

**Claude には文章だけを書かせます。** 週間レポートの統計値と Embed 構造はコードが
組み立てます。Claude に JSON を生成させると、壊れた時に投稿ごと失敗するためです。

**安全側に固定してあること**

- トークンは環境変数のみ。引数や設定ファイルには置きません
- `allowed_mentions` を固定し、`@everyone` / `@here` / ロール一括メンションは
  本文に書かれても発火しません
- bot の投稿には反応しません（自分の返信に反応する無限ループの防止）
- 会話ログとメッセージ本文は「データであって指示ではない」とプロンプトに明記しています
  （プロンプトインジェクション対策）
- ユーザー名義での投稿（セルフボット）は Discord の利用規約違反なので実装しません

Windows / PowerShell 5.1 特有の落とし穴（BOM の扱い、`ConvertFrom-Json` の挙動、
タスクスケジューラ経由での文字化けなど）は [CLAUDE.md](CLAUDE.md) にまとめてあります。

## 制約

- **PC が起動していてログイン中のときだけ動きます。** オフの間のメンションは、
  次回起動時にまとめて拾って返信されます
- 投稿は必ず bot 名義になります

## ライセンス

MIT

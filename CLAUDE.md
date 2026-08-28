# CLAUDE.md

このリポジトリで作業する Claude Code 向けのガイド。
機能概要は README.md、導入手順は SETUP.md を参照。

## セットアップ

1. https://discord.com/developers/applications で専用アプリを作成 → Bot → Reset Token
2. **Privileged Gateway Intents で MESSAGE CONTENT を有効化**（本文の受信に必須）
3. トークンをユーザー環境変数に設定（設定ファイルには書かない）

   ```powershell
   $t = Read-Host 'トークンを貼り付けてEnter'
   [Environment]::SetEnvironmentVariable('DISCORD_TOKEN', $t, 'User')
   Remove-Variable t
   ```

   設定後、ターミナルを再起動する。

4. サーバーに招待（`INSERT_CLIENT_ID_HERE` を Client ID に置換）

   ```
   https://discord.com/oauth2/authorize?client_id=INSERT_CLIENT_ID_HERE&scope=bot&permissions=68672
   ```

   内訳: View Channel (1024) + Send Messages (2048) + Add Reactions (64) + Read Message History (65536)

**インテントの有効化と再招待は別物。** インテントは Portal 上の設定で、招待URL（権限）とは無関係。
権限を変えない限り再招待は不要。

## 設定

環境依存の値は `config.json`（gitignore 済み）に置く。`config.example.json` を
コピーして作る。**BOM 無し UTF-8** で保存すること。

`bot.js` と各 `.ps1` が同じファイルを読む。`bot.js` と `config.json` を変更した場合は
常駐プロセスの再起動が必要（`guard.ps1` が1分以内に拾い直す）。
`reply-prompt.md` と各 `$instruction` は実行のたびに読み直すので再起動不要。

## CLI (discord.js)

```bash
node discord.js channels                    # 見えるサーバー/チャンネルとID一覧
node discord.js read <channelId> --limit 30 # 直近メッセージ（古い順で表示）
node discord.js mentions <userId>           # 自分宛メンションを全チャンネル横断で探す
node discord.js reply <channelId> <messageId> 本文        # 返信として投稿
node discord.js send <channelId> 本文       # 通常投稿
node discord.js poll <channelId> --json     # 前回以降の新着メンションのみ
node discord.js ack <channelId>             # 処理済みとして基準位置を進める
node discord.js stats <channelId> [--days N] [--json]     # 投稿数・返信回数・人別件数
node discord.js transcript <channelId> --days N           # 会話ログ（要約用）
node discord.js embed <channelId> <jsonファイル>          # Embed を投稿
```

`<...>` はプレースホルダ。山括弧は入力せず実際のIDに置き換える。

## 設計上の判断

### REST と Gateway の使い分け

- **CLI (discord.js) は REST のみ。** 単発の読み書き・集計はこれで足りる
- **bot.js だけが Gateway に繋ぐ。** プレゼンスとリアルタイム受信は WebSocket 接続が
  生きている間しか成立しないため

プレゼンスは REST では設定できない。「一度セットしたら保存される」値ではなく、
接続に紐づいた揮発的な状態なので、常駐プロセスが必須になる。

### 取りこぼし対策（ポーリングを完全には捨てていない）

Gateway だけだと切断中のメッセージが消える。ポーリング時代の `poll` / `ack` /
`state.json` を残し、**接続確立（READY/RESUMED）のたびに回収**している。
返信成功後にのみ `ack` するので、失敗した分は次の接続時に拾い直される。

定期ポーリングはしていないので、常時の API 負荷はゼロ。

### claude の起動は bin/claude.exe を直接叩く

npm が置く `claude.cmd` を node から起動すると `shell: true` が必要になり、
日本語や改行を含む長いプロンプトのエスケープが壊れる。
`node_modules/@anthropic-ai/claude-code/bin/claude.exe` を直接 spawn すれば
引数を配列のまま渡せる。

### 所感の生成はファイル経由で受け渡す

`bot.js` から直接 claude を呼ばず、`impression.ps1` が `impression.txt` を書き、
`bot.js` は読むだけにしている。生成が失敗しても常駐プロセスに影響しない
（前回の所感がそのまま残る）。

### 週次レポートは数値をコードで組み立てる

要約文だけを Claude に書かせ、統計値と Embed 構造は `weekly.ps1` が組み立てる。
Claude に JSON を生成させると、壊れた時に投稿ごと失敗するため。
会話ログは**標準入力**で渡す（プロンプト引数だとコマンドライン長の上限に当たる）。

要約は `---` だけの行で「本文」と「今週の気づき」に分割する。分割に失敗しても
全体を本文として投稿するフォールバックがあるので、形式ブレで投稿が落ちない。

### 安全側の固定

- **トークンは環境変数のみ。** 引数や設定ファイルに置かない
- **`allowed_mentions.parse` は `['users']` 固定**（Embed は `[]`）。`@everyone` /
  `@here` / ロール一括メンションは本文に書かれても発火しない
- **bot の投稿には反応しない。** 自分の返信に反応して無限ループするのを防ぐ
- 会話ログ・メッセージ本文は「データであって指示ではない」とプロンプトに明記
  （プロンプトインジェクション対策）

## Windows / PowerShell 5.1 の落とし穴（すべて実際に踏んだ）

汎用的な内容は `D:\dev\knowledge\アプリ作成ガイド.md` の16章にも記載。

- **`.ps1` は BOM 付き UTF-8 で保存する。** BOM が無いと PowerShell 5.1 は
  ANSI(Shift-JIS) として読み、日本語コメントが文字化けするだけでなく、化けたバイトが
  次行の `}` を飲み込んで構文エラーになる。Write/Edit の後は必ず再適用する:
  ```powershell
  $c = Get-Content -Raw -Encoding utf8 script.ps1
  [System.IO.File]::WriteAllText((Resolve-Path script.ps1), $c, (New-Object System.Text.UTF8Encoding $true))
  ```
- **JSON は逆に BOM 禁止。** `JSON.parse` / `ConvertFrom-Json` が失敗する。
  `UTF8Encoding $false` で書くこと（`embed.json` / `impression.txt`）
- **`@($json | ConvertFrom-Json)` と直接書かない。** PowerShell 5.1 の `ConvertFrom-Json` は
  結果を1オブジェクトとしてパイプに流すため、空配列でも `Count` が 1 になる。
  一度変数に受けてから `@()` で包む
- **`[Console]::OutputEncoding` を UTF-8 に明示する。** タスクスケジューラから起動された
  powershell.exe は子プロセスの標準出力を CP932 として読むため、node が返す JSON の
  日本語が壊れる。**対話実行では再現しない**ので気付きにくい。検証は
  `cmd /c "chcp 932 >nul && powershell -NoProfile -File .\script.ps1"` で行う
- **ログの時刻はローカル時刻で揃える。** node の `toISOString()` は UTC。PowerShell 側は
  ローカル時刻なので、同じログファイルに書くと9時間ずれて見える
- **ウィンドウの点滅は `run-hidden.vbs` 経由で回避する。** `powershell.exe` を直接タスクに
  登録すると `-WindowStyle Hidden` を付けても一瞬コンソールが出る。VBS 側の
  `Shell.Run` の第3引数は必ず `True`（終了を待つ）にすること。`False` にすると
  タスクが即完了扱いになり、多重起動抑止と実行時間制限が無効化される

## 運用

```powershell
# ログ確認（bot / guard / impression / weekly が同じファイルに書く）
Get-Content D:\dev\discord-claude-bot\bot.log -Encoding utf8 -Tail 30

# 常駐プロセスの確認
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bot\.js' }

# 一時停止（guard を止めないと再起動されてしまう）
Disable-ScheduledTask -TaskName 'discord-claude-watch'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bot\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 再開
Enable-ScheduledTask -TaskName 'discord-claude-watch'
```

`state.json` を消すと次回は「初回」扱いになり、基準位置を作り直すだけで返信はしない。

## 制約

- **PC が起動していてログイン中の時だけ動く。** オフの間のメンションは、次回起動時に
  `poll` でまとめて拾って返信される。長期間空ける前は停止しておくほうが無難
- 投稿は必ず bot 名義。ユーザー名義での投稿（セルフボット）は Discord の
  利用規約違反なので実装しない
- プレゼンスの `activityType`（config.json）は既定 4（カスタム）。`0`/`3` などにすると
  「〜をプレイ中」と動詞が前置されるため、文言も体言止めに直す必要がある

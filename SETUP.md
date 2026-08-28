# セットアップ手順

ゼロからこの bot を動かすまでの手順です。所要 20〜30 分程度。

対象環境: **Windows 10/11 + Windows PowerShell 5.1**
（他OSでも `discord.js` の CLI 部分は動きますが、常駐・定期実行の仕組みは
タスクスケジューラ前提です）

---

## 0. 必要なもの

| | 用途 | 確認コマンド |
|---|---|---|
| Node.js 22 以上 | 組み込みの `fetch` / `WebSocket` を使うため | `node --version` |
| Claude Code CLI | 返信文・要約の生成 | `claude --version` |
| Discord アカウント | bot を置くサーバーの管理権限が必要 | |

npm パッケージのインストールは不要です（依存ゼロ）。

Claude Code は API キーではなくサブスクリプションで動きます。
`ANTHROPIC_API_KEY` は不要です。

---

## 1. Discord bot を作る

1. https://discord.com/developers/applications を開く
2. **New Application** → 名前を入力して作成
3. 左メニュー **Bot** → **Reset Token** → **Copy**
   - トークンは一度しか表示されません。閉じたら再度 Reset Token で作り直します
4. 同じ Bot ページで **Privileged Gateway Intents** の
   **MESSAGE CONTENT INTENT** を ON → **Save Changes**
   - メッセージ本文を受信するために必須です
   - ON にしないと Gateway が close code `4014` で切断します
5. 左メニュー **OAuth2** から **Client ID** をコピー

---

## 2. サーバーに招待する

下記URLの `INSERT_CLIENT_ID_HERE` を Client ID に置き換えてブラウザで開きます。
（`INSERT_CLIENT_ID_HERE` の部分だけを実際の値に置き換えます。それ以外は変更不要）

```
https://discord.com/oauth2/authorize?client_id=INSERT_CLIENT_ID_HERE&scope=bot&permissions=68672
```

`permissions=68672` の内訳:

| 権限 | 値 | 用途 |
|---|---|---|
| View Channel | 1024 | チャンネルを見る |
| Send Messages | 2048 | 返信・レポート投稿 |
| Add Reactions | 64 | リアクション |
| Read Message History | 65536 | 過去ログの集計 |

招待にはサーバーの管理権限が必要です。権限が無いサーバーには、管理者にこのURLを渡します。

> **インテントの有効化と再招待は別物です。** インテントは Developer Portal 上の設定で、
> 招待URL（権限）とは無関係です。権限を変えない限り再招待は不要です。

**非公開チャンネルを使う場合**、招待しただけでは bot から見えません。
チャンネル設定 → 権限 → メンバーを追加 → bot を追加し、
`チャンネルを見る` と `メッセージ履歴を読む` を許可してください。

---

## 3. リポジトリを置く

```powershell
git clone https://github.com/xyukyu/discord-claude-bot.git D:\dev\discord-claude-bot
cd D:\dev\discord-claude-bot
```

以降の手順はこのディレクトリを `D:\dev\discord-claude-bot` として書いています。
別の場所に置く場合は、後述のタスク登録コマンド内のパスをすべて読み替えてください。

---

## 4. トークンを環境変数に設定する

**設定ファイルには書きません。** ユーザー環境変数に入れます。

PowerShell で以下3行をそのままコピペしてください（置き換え箇所はありません）。

```powershell
$t = Read-Host 'トークンを貼り付けてEnter'
[Environment]::SetEnvironmentVariable('DISCORD_TOKEN', $t, 'User')
Remove-Variable t
```

1行目でプロンプトが出るので、そこにトークンを貼り付けて Enter します。

> `[Environment]::SetEnvironmentVariable('DISCORD_TOKEN','トークン','User')` のように
> 直接タイプすると、その行が PowerShell の履歴ファイルに平文で残ります。
> 上の `Read-Host` を使う形なら履歴に残りません。

**設定後、PowerShell を開き直してください。** 環境変数はプロセス起動時に固定されるため、
開いたままのウィンドウには反映されません。

確認（トークン本体を表示せず、長さだけ見ます）:

```powershell
[Environment]::GetEnvironmentVariable('DISCORD_TOKEN','User').Length
```

70前後の数字が返れば成功です。`0` なら設定できていません。

---

## 5. 対象チャンネルを決める

bot が見えるチャンネルの一覧とIDを出します。

```powershell
cd D:\dev\discord-claude-bot
node discord.js channels
```

```
bot: くろーどちゃん (id=...)

# マイサーバー  guild=...
  #general  channel=123456789012345678
  #bot-chat channel=234567890123456789
```

`参加サーバーなし` と出たら、手順2の招待ができていません。

使いたいチャンネルの `channel=` の数字を控えます。

---

## 6. config.json を作る

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

`channelId` を手順5で控えた値に書き換えます。

```json
{
  "channelId": "234567890123456789",
  "statsDays": 7,
  "impressionDays": 3,
  "rotateSeconds": 20,
  "statsRefreshMinutes": 10,
  "activityType": 4,
  "embedColor": 5793266
}
```

| キー | 意味 |
|---|---|
| `channelId` | 監視・投稿するチャンネル |
| `statsDays` | 週間レポートとプレゼンスの集計期間（日） |
| `impressionDays` | 所感を作るときに読む会話の期間（日） |
| `rotateSeconds` | プレゼンスの切り替え間隔（20秒未満は非推奨。更新は20秒に5回まで） |
| `statsRefreshMinutes` | 統計を取り直す間隔 |
| `activityType` | `4`=カスタム / `0`=プレイ中 / `3`=視聴中 |
| `embedColor` | 週間レポートの色（10進数） |

> **`config.json` は BOM なし UTF-8 で保存してください。** BOM が付いていると
> `JSON.parse` / `ConvertFrom-Json` が失敗します。メモ帳なら「UTF-8」を選びます
> （「UTF-8 (BOM付き)」ではありません）。

---

## 7. 手動で動作確認する

```powershell
node discord.js read <チャンネルID> --limit 5
```

（`<チャンネルID>` は山括弧ごと実際の値に置き換えます）

メッセージが読めれば、トークンと権限は正しく設定できています。

次に bot 本体を前面で起動します。

```powershell
node bot.js
```

```
[2026-08-28 14:39:42] [bot] 接続します (identify)
[2026-08-28 14:39:42] [bot] READY: くろーどちゃん (id=...) としてオンラインになりました
```

`READY` が出れば成功です。Discord のメンバー一覧で bot がオンラインになり、
20秒ごとにステータス文が切り替わります。

この状態でチャンネルから `@bot名 こんにちは` とメンションすると、
10〜20秒で返信が来ます。

確認できたら `Ctrl + C` で止めます。

### うまくいかないとき

| 症状 | 原因 |
|---|---|
| `401 Unauthorized` | トークンが違う。手順4をやり直す |
| close code `4014` | MESSAGE CONTENT インテントが未有効。手順1-4 |
| `参加サーバーなし` | 招待できていない。手順2 |
| メンションしても無反応 | チャンネルIDが違う、または非公開チャンネルの権限不足 |
| `config.json を読めません` | 手順6。BOM 付きで保存していないか確認 |

---

## 8. タスクスケジューラに登録する

3つのタスクを登録します。**管理者権限は不要です。**
以下をそのままコピペしてください（`D:\dev\discord-claude-bot` 以外に置いた場合はパスを置換）。

```powershell
$dir = 'D:\dev\discord-claude-bot'
$common = @{
    Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    Force    = $true
}

# 1) bot.js の死活監視（毎分＋ログオン時）
$aGuard = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dir\run-hidden.vbs`" guard.ps1" -WorkingDirectory $dir
$tGuard = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$tLogon.Repetition = $tGuard.Repetition
Register-ScheduledTask -TaskName 'discord-claude-watch' -Action $aGuard -Trigger @($tGuard, $tLogon) @common | Out-Null

# 2) 所感の生成（毎時）
$aImp = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dir\run-hidden.vbs`" impression.ps1" -WorkingDirectory $dir
$tImp = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'discord-claude-impression' -Action $aImp -Trigger $tImp @common | Out-Null

# 3) 週間レポート（毎週日曜21時）
$aWeek = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$dir\run-hidden.vbs`" weekly.ps1" -WorkingDirectory $dir
$tWeek = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '21:00'
Register-ScheduledTask -TaskName 'discord-claude-weekly' -Action $aWeek -Trigger $tWeek @common | Out-Null

Get-ScheduledTask -TaskName 'discord-claude-*' | Select-Object TaskName, State
```

`State` が3つとも `Ready` になれば完了です。1分以内に bot が自動起動します。

> **`-RepetitionDuration` は指定していません。** `[TimeSpan]::MaxValue` を渡すと
> `P99999999DT23H59M59S` に変換されてタスクスケジューラに拒否されます。
> 省略すると無期限になります。

---

## 9. 動いていることを確認する

```powershell
# ログ（bot / guard / impression / weekly が同じファイルに書きます）
Get-Content D:\dev\discord-claude-bot\bot.log -Encoding utf8 -Tail 20

# 常駐プロセス
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bot\.js' }
```

週間レポートを今すぐ試したい場合:

```powershell
cd D:\dev\discord-claude-bot
powershell -ExecutionPolicy Bypass -File .\weekly.ps1
```

---

## 10. 停止・再開・削除

**プロセスだけ殺しても1分以内に `guard.ps1` が再起動します。** 先にタスクを止めてください。

```powershell
# 停止
Disable-ScheduledTask -TaskName 'discord-claude-watch'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bot\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 再開
Enable-ScheduledTask -TaskName 'discord-claude-watch'

# 完全に削除
'discord-claude-watch','discord-claude-impression','discord-claude-weekly' | ForEach-Object {
    Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
}
```

---

## カスタマイズ

| 変えたいもの | ファイル |
|---|---|
| 返信の口調・方針 | `reply-prompt.md` |
| 週間レポートの文体・観点 | `weekly.ps1` の `$instruction` |
| プレゼンスの所感の書き方 | `impression.ps1` の `$instruction` |
| プレゼンスの表示内容 | `bot.js` の `refreshLines()` |
| チャンネル・間隔・色 | `config.json` |

`reply-prompt.md` や各 `$instruction` を編集したら、bot の再起動は不要です
（実行のたびに読み直します）。`config.json` と `bot.js` を変えた場合は再起動が必要です。

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bot\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

`guard.ps1` が1分以内に新しい設定で起動し直します。

---

## 編集時の注意（Windows 特有）

`.ps1` を編集したら、**BOM 付き UTF-8 で保存し直してください。**
BOM が無いと PowerShell 5.1 は Shift-JIS として読み、日本語コメントが化けるだけでなく、
化けたバイトが次行の `}` を飲み込んで構文エラーになります。

```powershell
$c = Get-Content -Raw -Encoding utf8 .\weekly.ps1
[System.IO.File]::WriteAllText((Resolve-Path .\weekly.ps1), $c, (New-Object System.Text.UTF8Encoding $true))
```

**JSON は逆に BOM 禁止**です（`config.json`）。パースに失敗します。

タスクスケジューラ経由でのみ起きる不具合を再現したいときは、CP932 のコンソールで叩きます。

```powershell
cmd /c "chcp 932 >nul && powershell -NoProfile -ExecutionPolicy Bypass -File .\weekly.ps1"
```

その他の落とし穴は `CLAUDE.md` に一覧があります。

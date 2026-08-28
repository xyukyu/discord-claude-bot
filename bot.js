#!/usr/bin/env node
// Discord Gateway に常駐して、メンションへのリアルタイム返信とプレゼンス表示を行う。
//
// 設計上の注意:
//   - 返信が即時になる（最大5秒待ちが無くなる）
//   - ただしプロセスが落ちると返信が完全に止まる → 監視タスクで再起動させること
//   - 切断中のメッセージは取りこぼす → READY/RESUMED 時に poll で回収する（下記 catchUp）
//
// 必要な Privileged Intent: MESSAGE CONTENT（Developer Portal で有効化）
// 依存パッケージなし（Node 22+ の組み込み WebSocket を使う）。

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const TOKEN = process.env.DISCORD_TOKEN;
const API = 'https://discord.com/api/v10';

// --- 設定 -------------------------------------------------------------------
// config.json に切り出してある（config.example.json をコピーして作る）。
// チャンネルIDのような環境依存の値をコードに埋めないため。

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(
      `config.json を読めません: ${e.message}\n` +
        'config.example.json をコピーして config.json を作り、channelId を設定してください。'
    );
    process.exit(1);
  }
}

const config = loadConfig();

const CHANNEL = config.channelId;
const DAYS = config.statsDays ?? 7; // 「◯回やり取りした」の集計期間

const ROTATE_MS = (config.rotateSeconds ?? 20) * 1000; // 更新は20秒に5回までなので詰めすぎない
const STATS_MS = (config.statsRefreshMinutes ?? 10) * 60_000;
const IMPRESSION_FILE = path.join(__dirname, 'impression.txt');
const LOG_FILE = path.join(__dirname, 'bot.log');

// GUILD_MESSAGES(1<<9) | MESSAGE_CONTENT(1<<15)
const INTENTS = 512 | 32768;

// 0=プレイ中 / 2=再生中 / 3=視聴中 / 4=カスタム / 5=参加中
// 4 以外は「〜をプレイ中」と動詞が前置されるため、文章を出すなら 4 が自然。
// bot でのカスタムステータス対応には環境差があるので、崩れて見えたら 0 に変える。
const ACTIVITY_TYPE = config.activityType ?? 4;

// ---------------------------------------------------------------------------

if (!TOKEN) {
  console.error('DISCORD_TOKEN が未設定です');
  process.exit(1);
}

if (!CHANNEL) {
  console.error('config.json に channelId が設定されていません');
  process.exit(1);
}

function log(msg) {
  // toISOString() は UTC。PowerShell 側のログはローカル時刻なので、
  // 同じファイルに混在すると時刻がずれて見える。ローカル時刻で揃える。
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const line = `[${ts}] [bot] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* ログ書き込み失敗で本体を止めない */
  }
}

// --- 外部コマンド -----------------------------------------------------------

function runNode(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'discord.js'), ...args],
      { cwd: __dirname, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

// npm が置く claude.cmd を経由すると shell 必須になりエスケープが危うい。
// パッケージ本体の .exe を直接叩けば引数を配列のまま渡せる。
function resolveClaude() {
  const exe = path.join(
    process.env.APPDATA || '',
    'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  );
  return fs.existsSync(exe) ? exe : null;
}

const CLAUDE = resolveClaude();

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE) return reject(new Error('claude.exe が見つかりません'));
    execFile(
      CLAUDE,
      ['-p', prompt, '--allowedTools', 'Bash(node discord.js *)'],
      { cwd: __dirname, env: process.env, maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

// --- プレゼンス表示 ---------------------------------------------------------

let lines = ['起動したにゅ。'];
let rotateIndex = 0;

function readImpression() {
  try {
    return fs.readFileSync(IMPRESSION_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function refreshLines() {
  const [weeklyRaw, totalRaw] = await Promise.all([
    runNode(['stats', CHANNEL, '--days', String(DAYS), '--json']),
    runNode(['stats', CHANNEL, '--json']),
  ]);

  let weekly = null;
  let total = null;
  try {
    weekly = weeklyRaw && JSON.parse(weeklyRaw);
    total = totalRaw && JSON.parse(totalRaw);
  } catch {
    return;
  }

  const next = [];
  for (const u of weekly?.users?.filter((x) => !x.bot) || []) {
    next.push(`${u.name}と${u.count}回やり取りしたにゅ。`);
  }
  const impression = readImpression();
  if (impression) next.push(impression);
  if (total) next.push(`今までの累計やり取りは${total.botReplies}回だにゅ。`);

  if (next.length) {
    lines = next;
    if (rotateIndex >= lines.length) rotateIndex = 0;
  }
}

function presencePayload() {
  const text = lines[rotateIndex % lines.length].slice(0, 128);
  rotateIndex = (rotateIndex + 1) % lines.length;
  const activity =
    ACTIVITY_TYPE === 4
      ? { name: 'Custom Status', type: 4, state: text }
      : { name: text, type: ACTIVITY_TYPE };
  return { since: 0, activities: [activity], status: 'online', afk: false };
}

// --- 返信キュー -------------------------------------------------------------
// claude を同時に複数起動しないよう直列で処理する。

const queue = [];
const handled = new Set(); // RESUME でイベントが再送されることがあるので重複を弾く
let working = false;

function remember(id) {
  handled.add(id);
  if (handled.size > 500) handled.delete(handled.values().next().value);
}

function enqueue(items) {
  const fresh = items.filter((m) => !handled.has(m.id));
  for (const m of fresh) remember(m.id);
  if (!fresh.length) return;
  queue.push(...fresh);
  drain();
}

async function drain() {
  if (working) return;
  working = true;

  try {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      log(`返信対象 ${batch.length} 件: ${batch.map((m) => m.id).join(',')}`);

      const payload = JSON.stringify(
        batch.map((m) => ({
          id: m.id,
          author: m.author?.global_name || m.author?.username,
          content: m.content,
          timestamp: m.timestamp,
        }))
      );

      const template = fs.readFileSync(path.join(__dirname, 'reply-prompt.md'), 'utf8');
      const prompt = template.split('__MENTIONS__').join(payload).split('__CHANNEL__').join(CHANNEL);

      try {
        const out = await runClaude(prompt);
        log(`Claude 応答: ${String(out).trim().slice(0, 300)}`);
        // 取りこぼし回収 (catchUp) の基準位置を進める
        await runNode(['ack', CHANNEL]);
      } catch (e) {
        log(`ERROR: 返信に失敗 - ${e.message}`);
        // ack しないので、次回の catchUp で拾い直される
      }
    }
  } finally {
    working = false;
  }
}

// 切断中に来たメンションを poll で回収する。
// Gateway だけだと切断中のメッセージを取りこぼすため、接続確立のたびに実行する。
async function catchUp() {
  const out = await runNode(['poll', CHANNEL, '--json']);
  if (!out) return;
  let items;
  try {
    items = JSON.parse(out);
  } catch {
    return;
  }
  if (Array.isArray(items) && items.length) {
    log(`取りこぼしを ${items.length} 件回収しました`);
    enqueue(items);
  }
}

// --- Gateway ----------------------------------------------------------------

let ws = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let botId = null;
let heartbeatTimer = null;
let rotateTimer = null;
let acked = true;
let backoff = 1000;

function send(op, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

function stopTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (rotateTimer) clearInterval(rotateTimer);
  heartbeatTimer = null;
  rotateTimer = null;
}

function startRotation() {
  if (!rotateTimer) rotateTimer = setInterval(() => send(3, presencePayload()), ROTATE_MS);
}

function beat(interval) {
  heartbeatTimer = setInterval(() => {
    if (!acked) {
      log('HEARTBEAT ACK が無いため再接続します');
      stopTimers();
      if (ws) ws.close(4000);
      return;
    }
    acked = false;
    send(1, seq);
  }, interval);
}

function scheduleReconnect() {
  const wait = backoff;
  backoff = Math.min(backoff * 2, 60_000);
  log(`${Math.round(wait / 1000)}秒後に再接続します`);
  setTimeout(() => connect(Boolean(sessionId)), wait);
}

// このメッセージに反応すべきか
function shouldReply(d) {
  if (d.channel_id !== CHANNEL) return false;
  if (d.author?.bot) return false; // 自分や他 bot に反応して無限ループしない
  const mentioned = (d.mentions || []).some((u) => u.id === botId);
  const repliedToMe = d.referenced_message?.author?.id === botId;
  return mentioned || repliedToMe;
}

async function connect(resume = false) {
  stopTimers();

  let url;
  try {
    if (resume && resumeUrl) {
      url = resumeUrl;
    } else {
      const res = await fetch(`${API}/gateway/bot`, {
        headers: { authorization: `Bot ${TOKEN}`, connection: 'close' },
      });
      if (!res.ok) throw new Error(`GET /gateway/bot -> ${res.status}`);
      url = (await res.json()).url;
    }
  } catch (e) {
    log(`ERROR: Gateway URL の取得に失敗 - ${e.message}`);
    return scheduleReconnect();
  }

  log(`接続します (${resume ? 'resume' : 'identify'})`);
  ws = new WebSocket(`${url}?v=10&encoding=json`);

  ws.onopen = () => {
    acked = true;
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const { op, d, s, t } = msg;
    if (s !== null && s !== undefined) seq = s;

    if (op === 10) {
      const interval = d.heartbeat_interval;
      // 初回だけ jitter を掛ける（全 bot が同時に叩かないようにするため）
      setTimeout(() => {
        if (!heartbeatTimer) beat(interval);
      }, interval * Math.random());

      if (resume && sessionId) {
        send(6, { token: TOKEN, session_id: sessionId, seq });
      } else {
        send(2, {
          token: TOKEN,
          intents: INTENTS,
          properties: { os: 'windows', browser: 'discord-claude-bot', device: 'discord-claude-bot' },
          presence: presencePayload(),
        });
      }
      return;
    }

    if (op === 11) {
      acked = true;
      return;
    }

    if (op === 7) {
      log('RECONNECT 要求を受信');
      ws.close(4000);
      return;
    }

    if (op === 9) {
      log('INVALID SESSION。再 IDENTIFY します');
      sessionId = null;
      resumeUrl = null;
      ws.close(4000);
      return;
    }

    if (op !== 0) return;

    if (t === 'READY') {
      sessionId = d.session_id;
      resumeUrl = d.resume_gateway_url;
      botId = d.user?.id;
      backoff = 1000;
      log(`READY: ${d.user?.username} (id=${botId}) としてオンラインになりました`);
      startRotation();
      catchUp();
      return;
    }

    if (t === 'RESUMED') {
      backoff = 1000;
      log('RESUMED');
      startRotation();
      catchUp();
      return;
    }

    if (t === 'MESSAGE_CREATE' && shouldReply(d)) {
      log(`メンション受信: ${d.author?.username} "${(d.content || '').slice(0, 40)}"`);
      enqueue([d]);
    }
  };

  ws.onclose = (ev) => {
    log(`切断されました (code=${ev.code})`);
    stopTimers();
    // 4004=認証失敗 / 4013,4014=intent不正。再接続しても直らない
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code)) {
      log(`復旧不能なコード ${ev.code} のため終了します`);
      if (ev.code === 4014) {
        log('→ Developer Portal で MESSAGE CONTENT インテントを有効にしてください');
      }
      process.exit(1);
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose が続けて呼ばれるのでここでは何もしない */
  };
}

// --- 起動 -------------------------------------------------------------------

process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e}`));
process.on('uncaughtException', (e) => log(`uncaughtException: ${e}`));

(async () => {
  if (!CLAUDE) log('警告: claude.exe が見つかりません。返信はできません（プレゼンスのみ動作）');
  await refreshLines();
  setInterval(refreshLines, STATS_MS);
  connect(false);
})();

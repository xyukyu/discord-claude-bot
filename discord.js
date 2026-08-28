#!/usr/bin/env node
// Discord REST CLI — 依存ゼロ。Node 18+ の組み込み fetch を使う。
// token は環境変数 DISCORD_TOKEN から読む（設定ファイルには書かない）。

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_TOKEN;
const STATE_FILE = path.join(__dirname, 'state.json');

class CliError extends Error {}

// 通信中に process.exit() を呼ぶと Windows で libuv のアサーションに引っかかるため、
// 例外を投げて main() の catch で exitCode を立てる。
function die(msg) {
  throw new CliError(msg);
}

// --- HTTP ------------------------------------------------------------------

async function api(path, opts = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        authorization: `Bot ${TOKEN}`,
        'content-type': 'application/json',
        // keep-alive のソケットが残るとプロセスが数秒終了しないので毎回閉じる
        connection: 'close',
        'user-agent': 'DiscordBot (https://localhost/discord-claude-bot, 1.0)',
        ...(opts.headers || {}),
      },
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = (body.retry_after ?? 1) * 1000;
      console.error(`rate limited, retrying in ${Math.ceil(wait / 1000)}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      die(`${res.status} ${res.statusText} on ${path}\n${text}`);
    }

    return res.status === 204 ? null : res.json();
  }
  die(`rate limit retries exhausted on ${path}`);
}

// --- formatting ------------------------------------------------------------

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMessage(m, { channelId } = {}) {
  const author = m.author?.global_name || m.author?.username || 'unknown';
  const bot = m.author?.bot ? ' [BOT]' : '';
  const lines = [];
  lines.push(`--- ${fmtTime(m.timestamp)}  ${author}${bot}  msg=${m.id}`);

  if (m.referenced_message) {
    const ra =
      m.referenced_message.author?.global_name || m.referenced_message.author?.username || '?';
    const rc = (m.referenced_message.content || '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(`    ↳ reply to ${ra}: ${rc}`);
  }

  lines.push(m.content || '(本文なし)');

  for (const a of m.attachments || []) lines.push(`    [添付] ${a.filename} ${a.url}`);
  for (const e of m.embeds || []) {
    if (e.title || e.description) {
      const desc = (e.description || '').replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`    [embed] ${e.title || ''} ${desc}`);
    }
  }
  if (m.mentions?.length) {
    const names = m.mentions.map((u) => '@' + (u.global_name || u.username)).join(' ');
    lines.push(`    [mentions] ${names}`);
  }
  if (channelId) lines.push(`    channel=${channelId}`);
  return lines.join('\n');
}

// --- commands --------------------------------------------------------------

// 0=TEXT, 5=ANNOUNCEMENT, 10/11/12=threads, 15=FORUM
const READABLE_TYPES = new Set([0, 5, 10, 11, 12, 15]);

async function listChannels() {
  const me = await api('/users/@me');
  console.log(`bot: ${me.username} (id=${me.id})\n`);

  const guilds = await api('/users/@me/guilds');
  if (!guilds.length) {
    console.log('参加サーバーなし。bot を招待してください。');
    return;
  }

  for (const g of guilds) {
    console.log(`# ${g.name}  guild=${g.id}`);
    const channels = await api(`/guilds/${g.id}/channels`);
    for (const c of channels.filter((c) => READABLE_TYPES.has(c.type))) {
      console.log(`  #${c.name}  channel=${c.id}`);
    }
    console.log();
  }
}

async function readChannel(channelId, limit) {
  const msgs = await api(`/channels/${channelId}/messages?limit=${limit}`);
  if (!msgs.length) {
    console.log('メッセージなし');
    return;
  }
  // API は新しい順で返るので、読みやすいよう古い順に並べ替える
  for (const m of msgs.reverse()) console.log(fmtMessage(m) + '\n');
}

async function findMentions(userId, { limit, channelId }) {
  const targets = [];

  if (channelId) {
    targets.push({ id: channelId, name: channelId, guild: '' });
  } else {
    const guilds = await api('/users/@me/guilds');
    for (const g of guilds) {
      const channels = await api(`/guilds/${g.id}/channels`);
      for (const c of channels.filter((c) => c.type === 0 || c.type === 5)) {
        targets.push({ id: c.id, name: c.name, guild: g.name });
      }
    }
  }

  let found = 0;
  for (const t of targets) {
    // 権限のないチャンネルは 403 になる。握りつぶして次へ。
    const res = await fetch(`${API}/channels/${t.id}/messages?limit=${limit}`, {
      headers: { authorization: `Bot ${TOKEN}`, connection: 'close' },
    });
    if (!res.ok) continue;
    const msgs = await res.json();

    for (const m of msgs.reverse()) {
      const mentioned =
        (m.mentions || []).some((u) => u.id === userId) ||
        (m.content || '').includes(`<@${userId}>`);
      if (!mentioned) continue;
      const label = t.guild ? `${t.guild} #${t.name}` : `#${t.name}`;
      console.log(`[${label}]`);
      console.log(fmtMessage(m, { channelId: t.id }) + '\n');
      found++;
    }
  }

  if (!found) {
    console.log(`直近 ${limit} 件以内に <@${userId}> 宛のメンションは見つかりませんでした。`);
  }
}

// --- stats -------------------------------------------------------------------

// 全角文字を2桁として数える。padEnd は UTF-16 単位で数えるため、
// 日本語名が混ざると桁が揃わない。
const FULLWIDTH =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += FULLWIDTH.test(ch) ? 2 : 1;
  return w;
}

// チャンネル履歴をたどる。100件ずつしか取れないので before で遡る。
// since を渡すとその日時より古いページに入った時点で打ち切る。
async function collectMessages(channelId, { max, since }) {
  const all = [];
  let before = null;

  while (all.length < max) {
    const q = before ? `?limit=100&before=${before}` : '?limit=100';
    const page = await api(`/channels/${channelId}/messages${q}`);
    if (!page.length) break;

    all.push(...page);
    before = page[page.length - 1].id;

    // 取得は新しい順。ページ末尾が期間外なら、それ以上遡る必要はない
    if (since && new Date(page[page.length - 1].timestamp) < since) break;
    if (page.length < 100) break; // 最後のページ
  }

  return since ? all.filter((m) => new Date(m.timestamp) >= since) : all;
}

// --days N を Date に変換する（N日前の 00:00 ではなく「今から N*24時間前」）
function sinceFromDays(days) {
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function stats(channelId, { json, max, days }) {
  const since = sinceFromDays(days);
  const msgs = await collectMessages(channelId, { max, since });
  if (!msgs.length) {
    if (json) console.log(JSON.stringify({ channelId, totalMessages: 0, botReplies: 0, users: [] }));
    else console.log('対象期間にメッセージがありません');
    return;
  }

  const me = await api('/users/@me');

  // ユーザーIDをキーにした Map。文字列連結でキーを作ると区切り文字の選定が
  // 必要になるので、素直にオブジェクトを持たせる。
  const byUser = new Map();
  let botReplies = 0;

  for (const m of msgs) {
    const id = m.author?.id;
    if (!byUser.has(id)) {
      byUser.set(id, {
        id,
        name: m.author?.global_name || m.author?.username || 'unknown',
        bot: Boolean(m.author?.bot),
        count: 0,
      });
    }
    byUser.get(id).count++;

    // bot 自身が message_reference 付きで投稿したもの = 返信回数
    if (id === me.id && m.referenced_message) botReplies++;
  }

  const rows = [...byUser.values()].sort((a, b) => b.count - a.count);

  // タイムスタンプは新しい順で取得しているので、末尾が最古
  const oldest = msgs[msgs.length - 1].timestamp;
  const newest = msgs[0].timestamp;

  const result = {
    channelId,
    totalMessages: msgs.length,
    botReplies,
    days: days || null,
    since: oldest,
    until: newest,
    users: rows,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`総メッセージ数 : ${result.totalMessages}`);
  console.log(`bot の返信回数 : ${botReplies}`);
  console.log(`集計期間       : ${fmtTime(oldest)} 〜 ${fmtTime(newest)}`);
  console.log('');
  console.log('投稿数（多い順）');
  const width = Math.max(...rows.map((r) => displayWidth(r.name)));
  for (const r of rows) {
    const pad = ' '.repeat(width - displayWidth(r.name));
    console.log(`  ${r.name}${pad}${r.bot ? ' [BOT]' : '      '}  ${String(r.count).padStart(4)} 件`);
  }
}

// --- transcript ---------------------------------------------------------------

// 指定期間の会話を、要約させやすい素のテキストで出す
async function transcript(channelId, { days, max }) {
  const since = sinceFromDays(days);
  const msgs = await collectMessages(channelId, { max, since });
  if (!msgs.length) {
    console.log('(対象期間に会話はありませんでした)');
    return;
  }

  // 取得は新しい順なので、読みやすいよう古い順に直す
  for (const m of msgs.reverse()) {
    const author = m.author?.global_name || m.author?.username || 'unknown';
    const bot = m.author?.bot ? '(bot)' : '';
    const body = (m.content || '').replace(/\n/g, ' ').trim();
    if (!body) continue;
    console.log(`[${fmtTime(m.timestamp)}] ${author}${bot}: ${body}`);
  }
}

// --- embed ---------------------------------------------------------------------

// Embed のペイロードを JSON ファイルから読んで投稿する。
// 引数で渡すと改行や日本語のクォートで壊れるため、必ずファイル経由にしている。
async function sendEmbed(channelId, filePath) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    die(`Embed の JSON を読めません (${filePath}): ${e.message}`);
  }

  if (!payload.embeds && !payload.content) {
    die('JSON に embeds も content もありません');
  }

  // @everyone / ロール一括メンションは常に無効化する
  payload.allowed_mentions = { parse: [] };

  const sent = await api(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  let guildId = sent.guild_id;
  if (!guildId) {
    const ch = await api(`/channels/${channelId}`).catch(() => null);
    guildId = ch?.guild_id;
  }

  console.log(`投稿しました: msg=${sent.id}`);
  console.log(`https://discord.com/channels/${guildId || '@me'}/${channelId}/${sent.id}`);
}

// --- state (差分検知用) ------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// 未処理の新着メンションを JSON で出力する。Claude を呼ぶ前の無料の事前チェック用。
// state は ack コマンドで明示的に進める（返信に失敗したら次回また拾えるように）。
async function poll(channelId, targetIds, { json }) {
  const state = readState();
  const lastSeen = state[channelId];

  // after を付けると「そのID以降」だけが返る。初回は直近1件だけ見て以後の基準にする。
  const query = lastSeen ? `?after=${lastSeen}&limit=50` : '?limit=1';
  const msgs = await api(`/channels/${channelId}/messages${query}`);

  const hits = msgs
    .reverse()
    .filter((m) => !m.author?.bot) // bot 自身の投稿には反応しない（無限ループ防止）
    .filter((m) =>
      targetIds.some(
        (id) =>
          (m.mentions || []).some((u) => u.id === id) ||
          (m.content || '').includes(`<@${id}>`) ||
          // 監視対象の投稿への返信も拾う。Discord の返信は @ トグルをOFFにすると
          // mentions に入らないため、これが無いと会話の途中で無視されてしまう。
          m.referenced_message?.author?.id === id
      )
    );

  // 初回は基準を作るだけで返信しない
  if (!lastSeen) {
    const newest = msgs.length ? msgs[msgs.length - 1].id : null;
    if (newest) writeState({ ...state, [channelId]: newest });
    if (json) console.log('[]');
    else console.log('初回のため基準位置を記録しました。次回から差分を検知します。');
    return;
  }

  if (json) {
    console.log(
      JSON.stringify(
        hits.map((m) => ({
          id: m.id,
          author: m.author?.global_name || m.author?.username,
          content: m.content,
          timestamp: m.timestamp,
        }))
      )
    );
    return;
  }

  if (!hits.length) {
    console.log('新着メンションなし');
    return;
  }
  for (const m of hits) console.log(fmtMessage(m, { channelId }) + '\n');
}

// 処理済みとして基準位置を最新まで進める
async function ack(channelId) {
  const msgs = await api(`/channels/${channelId}/messages?limit=1`);
  if (!msgs.length) {
    console.log('メッセージなし。基準位置は変更しません。');
    return;
  }
  const state = readState();
  writeState({ ...state, [channelId]: msgs[0].id });
  console.log(`基準位置を ${msgs[0].id} まで進めました。`);
}

async function sendMessage(channelId, content, { replyTo, silent } = {}) {
  const body = {
    content,
    // @everyone / @here / ロール一括メンションは常に無効化する
    allowed_mentions: { parse: ['users'], replied_user: !silent },
  };
  if (replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };

  const sent = await api(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // 投稿レスポンスに guild_id が入らないことがあるので、その場合はチャンネルから引く
  let guildId = sent.guild_id;
  if (!guildId) {
    const ch = await api(`/channels/${channelId}`).catch(() => null);
    guildId = ch?.guild_id;
  }

  console.log(`送信しました: msg=${sent.id}`);
  console.log(`https://discord.com/channels/${guildId || '@me'}/${channelId}/${sent.id}`);
}

// --- arg parsing -----------------------------------------------------------

const FLAGS_WITH_VALUE = new Set(['--limit', '--channel', '--target', '--max', '--days']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (FLAGS_WITH_VALUE.has(a)) flags[a] = argv[++i];
      else flags[a] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const USAGE = `使い方: node discord.js <command> [args]

  channels                          bot が見えるサーバー/チャンネルの一覧とID
  read <channelId> [--limit N]      チャンネルの直近メッセージ (既定 20, 最大 100)
  mentions <userId> [--limit N] [--channel <id>]
                                    自分宛メンションを探す
  reply <channelId> <messageId> <本文> [--silent]
                                    そのメッセージへの返信として投稿
  send <channelId> <本文>           チャンネルに通常投稿
  poll <channelId> [--target <id1,id2>] [--json]
                                    前回以降の新着メンションだけを出す（自動返信用）
                                    --target 省略時は bot 自身宛のみ。カンマ区切りで複数可
  ack <channelId>                   処理済みとして基準位置を最新まで進める
  stats <channelId> [--days N] [--max N] [--json]
                                    投稿数・bot返信回数・人別件数を集計
  transcript <channelId> [--days N] [--max N]
                                    指定期間の会話をテキストで出力（要約用）
  embed <channelId> <jsonファイル>   Embed を投稿（JSONはファイル経由）

環境変数 DISCORD_TOKEN が必要です。`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  const COMMANDS = [
    'channels', 'read', 'mentions', 'reply', 'send',
    'poll', 'ack', 'stats', 'transcript', 'embed',
  ];
  if (!cmd || !COMMANDS.includes(cmd)) {
    console.log(USAGE);
    process.exitCode = cmd ? 1 : 0;
    return;
  }

  if (!TOKEN) {
    die(
      'DISCORD_TOKEN が未設定です。\n' +
        "  PowerShell: [Environment]::SetEnvironmentVariable('DISCORD_TOKEN','トークン','User')\n" +
        '  設定後、ターミナルを再起動してください。'
    );
  }

  const { positional, flags } = parseArgs(argv.slice(1));
  const limit = Math.min(Math.max(Number(flags['--limit']) || 20, 1), 100);

  switch (cmd) {
    case 'channels':
      return listChannels();

    case 'read':
      if (!positional[0]) die('channelId が必要です');
      return readChannel(positional[0], limit);

    case 'mentions':
      if (!positional[0]) {
        die('userId が必要です（Discord で開発者モードON → ユーザー右クリック → ユーザーIDをコピー）');
      }
      return findMentions(positional[0], { limit, channelId: flags['--channel'] || null });

    case 'reply':
      if (!positional[2]) die('使い方: reply <channelId> <messageId> <本文>');
      return sendMessage(positional[0], positional.slice(2).join(' '), {
        replyTo: positional[1],
        silent: Boolean(flags['--silent']),
      });

    case 'send':
      if (!positional[1]) die('使い方: send <channelId> <本文>');
      return sendMessage(positional[0], positional.slice(1).join(' '), {});

    case 'poll': {
      if (!positional[0]) die('channelId が必要です');
      // 既定の監視対象は bot 自身（= @くろーどちゃん 宛のメンション）
      // --target はカンマ区切りで複数指定できる
      const targets = flags['--target']
        ? String(flags['--target'])
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [(await api('/users/@me')).id];
      return poll(positional[0], targets, { json: Boolean(flags['--json']) });
    }

    case 'ack':
      if (!positional[0]) die('channelId が必要です');
      return ack(positional[0]);

    case 'stats': {
      if (!positional[0]) die('channelId が必要です');
      const max = Math.min(Math.max(Number(flags['--max']) || 5000, 1), 50000);
      const days = Number(flags['--days']) || null;
      return stats(positional[0], { json: Boolean(flags['--json']), max, days });
    }

    case 'transcript': {
      if (!positional[0]) die('channelId が必要です');
      const max = Math.min(Math.max(Number(flags['--max']) || 2000, 1), 50000);
      const days = Number(flags['--days']) || null;
      return transcript(positional[0], { days, max });
    }

    case 'embed':
      if (!positional[1]) die('使い方: embed <channelId> <jsonファイル>');
      return sendEmbed(positional[0], positional[1]);
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof CliError ? e.message : e.stack || e.message}`);
  process.exitCode = 1;
});

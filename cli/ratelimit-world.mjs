#!/usr/bin/env node
// ratelimit-world: Claude Code / Codex のローカルログから 5時間枠のリミット到達を読み取り、
// ratelimit.world に送るだけの小さな CLI。依存なし (Node 18+)。
//
//   node ratelimit-world.mjs setup [--server URL]   ログインして hooks を登録する
//   node ratelimit-world.mjs sync [--full]          今すぐ送る
//   node ratelimit-world.mjs scan [--days N]        送る内容を表示するだけ (通信なし)
//   node ratelimit-world.mjs status
//   node ratelimit-world.mjs uninstall
//
// 送るのは「どのツールが・いつリミットに到達し・いつリセットされ・リセット後いつ再開したか」だけ。
// プロンプトやコードは一切送らない。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const DEFAULT_SERVER = "https://ratelimit.world";
const HOME = path.join(os.homedir(), ".ratelimit-world");
const CONFIG_FILE = path.join(HOME, "config.json");
const INSTALLED_SCRIPT = path.join(HOME, "ratelimit-world.mjs");
const LOG_FILE = path.join(HOME, "sync.log");
const SELF = fileURLToPath(import.meta.url);

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = 5 * HOUR;
const HOOK_MARK = "ratelimit-world.mjs";

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
}
const loadConfig = () => readJson(CONFIG_FILE, {});
const saveConfig = (c) => { writeJson(CONFIG_FILE, c); try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {} };

function log(msg) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    // 肥大化しないよう 200KB を超えたら作り直す
    try { if (fs.statSync(LOG_FILE).size > 200_000) fs.writeFileSync(LOG_FILE, ""); } catch {}
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ---------- log files ----------
function* walkJsonl(dir, sinceMs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p, sinceMs);
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try { if (fs.statSync(p).mtimeMs >= sinceMs) yield p; } catch {}
    }
  }
}

function* lines(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split("\n")) if (line) yield line;
}

const parseLine = (line) => { try { return JSON.parse(line); } catch { return null; } };
const epochMs = (n) => (n < 1e12 ? n * 1000 : n);

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

// ---------- reset time from message text ----------
// タイムゾーン tz での壁時計 (y,m,d,h,min) を epoch ms にする
function zonedToEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}

// "resets 5:20pm (Australia/Melbourne)" / "resets 4:30am" → 到達時刻より後で最も近いその時刻
export function parseResetText(text, hitMs) {
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m || (!m[2] && !m[3])) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  let tz = m[4];
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = undefined; }
  tz ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(hitMs)).map((x) => [x.type, x.value]));
  for (let dd = -1; dd <= 1; dd++) {
    const t = zonedToEpoch(+p.year, +p.month - 1, +p.day + dd, h, min, tz);
    if (t > hitMs && t - hitMs <= WINDOW_MS + 15 * 60000) return t;
  }
  return null;
}

// ---------- Claude Code ----------
// リミット到達: isApiErrorMessage かつ error=rate_limit の合成メッセージ。
// 新しい版は quotaLimits.{rateLimitType, resetsAt} を持つので、それを優先する。
const WEEKLY_RE = /(weekly|week|opus limit|sonnet limit|monthly)/i;
export function scanClaude(sinceMs) {
  const hits = [], activity = [];
  for (const file of walkJsonl(path.join(claudeDir(), "projects"), sinceMs)) {
    for (const line of lines(file)) {
      if (line.includes('"isApiErrorMessage":true')) {
        const ev = parseLine(line);
        if (!ev) continue;
        const ts = Date.parse(ev.timestamp);
        const text = textOf(ev.message?.content);
        const q = ev.quotaLimits;
        const isLimit = ev.error === "rate_limit" || /hit your (?:session |usage )?limit|usage limit reached/i.test(text);
        if (!isLimit || !Number.isFinite(ts) || ts < sinceMs) continue;
        let reset = null;
        if (q?.rateLimitType) {
          if (q.rateLimitType !== "five_hour") continue;
          if (q.resetsAt) reset = epochMs(+q.resetsAt);
        } else if (WEEKLY_RE.test(text)) continue;
        reset ??= parseResetText(text, ts);
        // リセット時刻が分からない、または 5時間枠と矛盾するものは数えない (週次などの誤検出を避ける)
        if (!reset || reset <= ts || reset - ts > WINDOW_MS + 15 * 60000) continue;
        hits.push({ ts, reset });
      } else if (line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true')) {
        const ev = parseLine(line);
        if (ev?.type !== "user" || ev.isSidechain) continue;
        const ts = Date.parse(ev.timestamp);
        if (Number.isFinite(ts)) activity.push(ts);
      }
    }
  }
  return { hits, activity, current: null };
}

// ---------- Codex ----------
// token_count イベントの rate_limits.primary (window_minutes=300) に使用率とリセット時刻が毎回入る。
function fiveHour(rl) {
  if (!rl || typeof rl !== "object") return null;
  const c = [rl.primary, rl.secondary].filter(Boolean);
  return c.find((x) => Number(x.window_minutes) === 300) ?? null;
}

export function scanCodex(sinceMs) {
  const hits = [], activity = [];
  let current = null;
  for (const file of walkJsonl(path.join(codexDir(), "sessions"), sinceMs)) {
    for (const line of lines(file)) {
      if (line.includes('"token_count"')) {
        const ev = parseLine(line);
        const p = ev?.payload;
        if (p?.type !== "token_count") continue;
        const ts = Date.parse(ev.timestamp);
        const lim = fiveHour(p.rate_limits);
        if (!lim || !Number.isFinite(ts) || ts < sinceMs) continue;
        const reset = lim.resets_at != null ? epochMs(+lim.resets_at)
          : lim.resets_in_seconds != null ? ts + lim.resets_in_seconds * 1000 : null;
        const used = Number(lim.used_percent);
        if (reset && (!current || ts > current.at)) current = { at: ts, usedPercent: used, resetAt: reset };
        if (used >= 100 && reset) hits.push({ ts, reset });
      } else if (line.includes('"task_started"')) {
        const ev = parseLine(line);
        if (ev?.payload?.type !== "task_started") continue;
        const ts = Date.parse(ev.timestamp);
        if (Number.isFinite(ts)) activity.push(ts);
      }
    }
  }
  return { hits, activity, current };
}

// ---------- windows ----------
// 同じ枠への到達 (リトライなど) はリセット時刻で 1つにまとめる。
// resumedAt = リセット後に最初に使い始めた時刻 (「出遅れ」の計算に使う)
export function toWindows(tool, { hits, activity }) {
  const sorted = [...hits].sort((a, b) => a.reset - b.reset);
  const out = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.reset - last.resetAt < 15 * 60000) { last.hitAt = Math.min(last.hitAt, h.ts); continue; }
    out.push({ tool, hitAt: h.ts, resetAt: h.reset, resumedAt: null });
  }
  const acts = [...activity].sort((a, b) => a - b);
  for (const w of out) {
    const next = acts.find((t) => t >= w.resetAt);
    if (next != null) w.resumedAt = next;
  }
  return out;
}

export function collect(days) {
  const since = Date.now() - days * DAY;
  // 再開時刻を求めるため、到達より少し前からのログも読む
  const claude = scanClaude(since - WINDOW_MS);
  const codex = scanCodex(since - WINDOW_MS);
  const windows = [...toWindows("claude", claude), ...toWindows("codex", codex)]
    .filter((w) => w.resetAt >= since)
    .sort((a, b) => a.hitAt - b.hitAt);
  return {
    client: { version: VERSION, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: process.platform },
    windows,
    current: { codex: codex.current },
  };
}

// ---------- network ----------
async function api(cfg, method, p, body, timeoutMs = 8000) {
  const res = await fetch(new URL(p, cfg.server), {
    method,
    headers: { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

async function sync({ full = false, quiet = false, reason = "manual", active = null } = {}) {
  const cfg = loadConfig();
  if (!cfg.token) { if (!quiet) console.error("まだセットアップされていません: ratelimit-world setup"); return false; }
  // hook は毎ターン走るので、直近に送っていれば省略する (リミット到達時は必ず送る)
  if (reason === "hook" && cfg.lastSyncAt && Date.now() - cfg.lastSyncAt < 20_000) return true;
  const payload = collect(full ? 60 : 3);
  // プロンプト送信の瞬間に「今使い始めた」と伝える (ログに書かれる前でも再開時刻が分かるように)
  if (active) payload.active = { [active]: Date.now() };
  try {
    const r = await api(cfg, "POST", "/api/sync", payload);
    saveConfig({ ...loadConfig(), lastSyncAt: Date.now() });
    log(`sync ok (${reason}) windows=${payload.windows.length}`);
    if (!quiet) console.log(`送信しました: ${payload.windows.length} 件。今日 ${r.today ?? "?"} / ${r.goal ?? "?"} 回、${r.streak ?? 0} 日連続`);
    return true;
  } catch (e) {
    log(`sync failed (${reason}): ${e.message}`);
    if (!quiet) console.error(`送信に失敗しました: ${e.message}`);
    return false;
  }
}

// ---------- hooks ----------
// Claude Code / Codex から呼ばれる。待たせないよう、送信は切り離した子プロセスで行う。
function hook(tool, event, rest) {
  const args = [SELF, "sync", "--quiet", "--reason", event === "limit" ? "limit" : "hook"];
  if (event === "prompt") args.push("--active", tool);
  const child = spawn(process.execPath, args, {
    detached: true, stdio: "ignore",
  });
  child.unref();
  // Codex の notify は 1つしか登録できないので、元々あった notify をそのまま呼び直す
  if (tool === "codex") {
    const prev = loadConfig().prevCodexNotify;
    if (Array.isArray(prev) && prev.length) {
      const c = spawn(prev[0], [...prev.slice(1), ...rest], { detached: true, stdio: "ignore" });
      c.on("error", () => {});
      c.unref();
    }
  }
}

const nodeCmd = () => (process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath);
const claudeHookCmd = (event) => `${nodeCmd()} "${INSTALLED_SCRIPT}" hook claude ${event}`;

function installClaudeHooks() {
  const file = path.join(claudeDir(), "settings.json");
  const s = readJson(file, null) ?? (fs.existsSync(file) ? null : {});
  if (!s) throw new Error(`${file} を読めませんでした (JSON の形式を確認してください)`);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.ratelimit-world.bak`);
  s.hooks ??= {};
  const add = (event, matcher, cmd) => {
    s.hooks[event] = (s.hooks[event] ?? []).filter((g) => !JSON.stringify(g).includes(HOOK_MARK));
    s.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd, timeout: 10 }] });
  };
  add("StopFailure", "rate_limit", claudeHookCmd("limit")); // リミットに当たった瞬間
  add("UserPromptSubmit", null, claudeHookCmd("prompt"));   // 使い始めた瞬間 (出遅れの計測)
  add("Stop", null, claudeHookCmd("stop"));                 // 毎ターン終わり (Codex 分もここで拾う)
  writeJson(file, s);
  return file;
}

function removeClaudeHooks() {
  const file = path.join(claudeDir(), "settings.json");
  const s = readJson(file, null);
  if (!s?.hooks) return;
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = s.hooks[ev].filter((g) => !JSON.stringify(g).includes(HOOK_MARK));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeJson(file, s);
}

// config.toml の最上位にある 1行の notify = [...] を読み書きする (TOML パーサーは持たない)
const NOTIFY_RE = /^notify\s*=\s*(\[.*\])\s*$/m;
function installCodexNotify(cfg) {
  const file = path.join(codexDir(), "config.toml");
  if (!fs.existsSync(codexDir())) return null;
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const ours = [process.execPath, INSTALLED_SCRIPT, "hook", "codex", "turn"];
  const m = text.match(NOTIFY_RE);
  if (m) {
    let prev;
    try { prev = JSON.parse(m[1]); } catch { throw new Error(`${file} の notify を読めませんでした。手動で設定してください`); }
    if (!JSON.stringify(prev).includes(HOOK_MARK)) cfg.prevCodexNotify = prev;
    fs.copyFileSync(file, `${file}.ratelimit-world.bak`);
    text = text.replace(NOTIFY_RE, `notify = ${JSON.stringify(ours)}`);
  } else if (/^\s*notify\s*=/m.test(text)) {
    throw new Error(`${file} の notify が複数行で書かれているため自動設定できません`);
  } else {
    if (text) fs.copyFileSync(file, `${file}.ratelimit-world.bak`);
    // 最上位のキーなので、最初のテーブル見出しより前に置く
    text = `notify = ${JSON.stringify(ours)}\n` + text;
  }
  fs.writeFileSync(file, text);
  return file;
}

function removeCodexNotify(cfg) {
  const file = path.join(codexDir(), "config.toml");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(NOTIFY_RE);
  if (!m || !m[1].includes(HOOK_MARK)) return;
  const prev = cfg.prevCodexNotify;
  fs.writeFileSync(file, prev?.length ? text.replace(NOTIFY_RE, `notify = ${JSON.stringify(prev)}`) : text.replace(NOTIFY_RE, "").replace(/^\n/, ""));
}

// ---------- setup ----------
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

async function setup(server) {
  const cfg = { ...loadConfig(), server: server || loadConfig().server || DEFAULT_SERVER };
  console.log(`🔥 ratelimit.world のセットアップ (${cfg.server})\n`);
  const start = await api({ server: cfg.server }, "POST", "/api/cli/start", { platform: process.platform });
  console.log(`ブラウザでログインして、このコードを確認してください: ${start.userCode}\n  ${start.verifyUrl}\n`);
  if (!process.env.RATELIMIT_WORLD_NO_BROWSER) openBrowser(start.verifyUrl);
  const deadline = Date.now() + 10 * 60 * 1000;
  let token = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await api({ server: cfg.server }, "POST", "/api/cli/poll", { deviceCode: start.deviceCode });
      if (r.token) { token = r.token; cfg.login = r.login; break; }
    } catch (e) {
      if (/expired|invalid/.test(e.message)) throw e;
    }
  }
  if (!token) throw new Error("時間切れです。もう一度 setup を実行してください");
  cfg.token = token;

  fs.mkdirSync(HOME, { recursive: true });
  if (realpath(SELF) !== realpath(INSTALLED_SCRIPT)) fs.copyFileSync(SELF, INSTALLED_SCRIPT);
  saveConfig(cfg);
  console.log(`✅ @${cfg.login} としてログインしました`);

  const c = installClaudeHooks();
  console.log(`✅ Claude Code の hooks を登録しました (${c})`);
  try {
    const x = installCodexNotify(cfg);
    if (x) console.log(`✅ Codex の notify を登録しました (${x})${cfg.prevCodexNotify ? "。元の notify も引き続き呼ばれます" : ""}`);
  } catch (e) { console.log(`⚠️  ${e.message}`); }
  saveConfig(cfg);

  console.log("\n過去 60 日分のログを送ります…");
  await sync({ full: true, quiet: true });
  printHistory(collect(60).windows);
  console.log(`\n🎉 準備完了！ ブラウザに戻って、通知を ON にしてください。あとは普段どおり使うだけです。`);
}

// setup の最後に、これまでの記録をひと目で見せる
function printHistory(windows) {
  const c = process.stdout.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_, s) => s;
  const byTool = (t) => windows.filter((w) => w.tool === t).length;
  const delays = windows.filter((w) => w.resumedAt).map((w) => w.resumedAt - w.resetAt).filter((d) => d >= 0 && d <= 3 * HOUR);
  const lost = Math.round(delays.reduce((a, b) => a + b, 0) / 60000);
  console.log(`\n${c("1", "これまでの記録 (過去60日)")}`);
  console.log(`  使い切った枠   ${c("1;35", windows.length)}  (Claude Code ${byTool("claude")} / Codex ${byTool("codex")})`);
  if (delays.length) {
    console.log(`  平均の出遅れ   ${c("1;33", Math.round(lost / delays.length) + " 分")}  → 合計 ${Math.floor(lost / 60)}時間${lost % 60}分 を取りこぼしていました`);
  }
  // 直近14日を 1日1文字で: 0枠 · / 1枠 ▂ / 2枠 ▅ / 3枠以上 █
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY).toDateString();
    const n = windows.filter((w) => new Date(w.hitAt).toDateString() === d).length;
    days.push(n === 0 ? c("2", "·") : c("35", n === 1 ? "▂" : n === 2 ? "▅" : "█"));
  }
  console.log(`  直近14日       ${days.join(" ")}`);
}

function uninstall() {
  const cfg = loadConfig();
  removeClaudeHooks();
  removeCodexNotify(cfg);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log("hooks / notify を外し、~/.ratelimit-world を削除しました");
}

function status() {
  const cfg = loadConfig();
  const p = collect(7);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "-");
  console.log(`サーバー: ${cfg.server ?? "(未設定)"}  ログイン: ${cfg.login ? "@" + cfg.login : "(未ログイン)"}  最終送信: ${fmt(cfg.lastSyncAt)}`);
  console.log(`\n直近7日のリミット到達: ${p.windows.length} 回`);
  for (const w of p.windows) {
    const late = w.resumedAt ? `${Math.round((w.resumedAt - w.resetAt) / 60000)}分後に再開` : "未再開";
    console.log(`  ${w.tool.padEnd(6)} 到達 ${fmt(w.hitAt)} → リセット ${fmt(w.resetAt)} (${late})`);
  }
  const c = p.current.codex;
  if (c) console.log(`\nCodex 5時間枠: ${c.usedPercent}% 使用、${fmt(c.resetAt)} にリセット (${fmt(c.at)} 時点)`);
}

// ---------- main ----------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : null; };
const realpath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = process.argv[1] && realpath(process.argv[1]) === realpath(SELF);

if (isMain) {
  const cmd = argv[0];
  try {
    if (cmd === "setup") await setup(flag("--server"));
    else if (cmd === "sync") process.exitCode = (await sync({ full: argv.includes("--full"), quiet: argv.includes("--quiet"), reason: flag("--reason") || "manual", active: flag("--active") })) ? 0 : 1;
    else if (cmd === "hook") hook(argv[1], argv[2], argv.slice(3));
    else if (cmd === "scan") console.log(JSON.stringify(collect(Number(flag("--days")) || 7), null, 2));
    else if (cmd === "status") status();
    else if (cmd === "uninstall") uninstall();
    else console.log(`ratelimit-world ${VERSION}\n\n  setup [--server URL]  ログインして hooks を登録\n  sync [--full]         今すぐ送信\n  status                直近の到達と送信状況\n  scan [--days N]       送る内容を表示 (通信なし)\n  uninstall             hooks を外して削除`);
  } catch (e) {
    // hook から呼ばれたときに Claude Code / Codex を止めないよう、失敗は記録だけして終わる
    if (cmd === "hook") log(`hook error: ${e.message}`);
    else { console.error(`エラー: ${e.message}`); process.exitCode = 1; }
  }
}

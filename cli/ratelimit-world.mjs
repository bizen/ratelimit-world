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
import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const VERSION = "0.5.0";
const DEFAULT_SERVER = "https://ratelimit.world";
const HOME = path.join(os.homedir(), ".ratelimit-world");
const CONFIG_FILE = path.join(HOME, "config.json");
const INSTALLED_SCRIPT = path.join(HOME, "ratelimit-world.mjs");
const LOG_FILE = path.join(HOME, "sync.log");
const CLAUDE_USAGE_FILE = path.join(HOME, "claude-usage.json"); // ステータスラインの中継で受け取った使用率
const STATUS_FILE = path.join(HOME, "status.json");             // 送信の返事 (ストリーク・ツールの状態)。ステータスライン・メニューバー用
const SELF = fileURLToPath(import.meta.url);

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = 5 * HOUR;
const WEEK_MS = 7 * DAY;
const HOOK_MARK = "ratelimit-world.mjs";

// 表示の言語: RATELIMIT_WORLD_LANG > サイトで選んだ言語 (ログイン後に保存) > LC_ALL / LANG > OS の設定。日本語以外は英語
let ja = null;
const isJa = () => (ja ??= /^ja/i.test(
  process.env.RATELIMIT_WORLD_LANG || readJson(CONFIG_FILE, {}).lang || process.env.LC_ALL || process.env.LC_MESSAGES ||
  (/^(C|POSIX)\b/.test(process.env.LANG || "") ? "" : process.env.LANG) || Intl.DateTimeFormat().resolvedOptions().locale));
const L = (jaText, enText) => (isJa() ? jaText : enText);

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
// Claude デスクトップアプリの Cowork。セッションごとに Claude Code と同じ形式の会話ログと、audit.jsonl を残す
const coworkDir = () => process.env.RATELIMIT_WORLD_COWORK_DIR || (
  process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
  : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "local-agent-mode-sessions")
  : path.join(os.homedir(), ".config", "Claude", "local-agent-mode-sessions"));

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

// 1行ずつ読む。ログは数百MBになることがあり (Node の文字列は約512MBが上限)、
// 丸ごと読むと失敗して黙って飛ばしてしまうので、8MBずつ読む
const CHUNK = 8 << 20;
const MAX_LINE = 256 << 20;
function* lines(file, startAt = 0) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(CHUNK);
    let pos = startAt, rest = null;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const chunk = rest ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0, i;
      while ((i = chunk.indexOf(10, start)) !== -1) {
        if (i > start) yield chunk.toString("utf8", start, i);
        start = i + 1;
      }
      rest = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
      if (rest && rest.length > MAX_LINE) rest = null; // 異常に長い 1行はあきらめる
    }
    if (rest?.length) yield rest.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// Codex のログは各行が {"timestamp":"..."} で始まり、時刻順に並ぶ。
// 大きなファイルは二分探索で「sinceMs 以降」が始まるあたりから読む (毎ターンの送信を速くするため)
function offsetSince(file, sinceMs) {
  let fd, size;
  try { fd = fs.openSync(file, "r"); size = fs.fstatSync(fd).size; } catch { return 0; }
  try {
    if (size < 32 << 20) return 0;
    const b = Buffer.alloc(256 << 10);
    let lo = 0, hi = size;
    while (hi - lo > 4 << 20) {
      const mid = Math.floor((lo + hi) / 2);
      const n = fs.readSync(fd, b, 0, b.length, mid);
      const s = b.toString("utf8", 0, n);
      const nl = s.indexOf("\n");
      const m = nl >= 0 ? s.slice(nl + 1, nl + 80).match(/^\{"timestamp":"([^"]+)"/) : null;
      const ts = m ? Date.parse(m[1]) : NaN;
      if (!Number.isFinite(ts)) break; // 判断できなければ、そこまでの安全な位置から読む
      if (ts < sinceMs) lo = mid; else hi = mid;
    }
    return lo;
  } finally {
    fs.closeSync(fd);
  }
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
// 応答の時刻 (その時刻に Claude Code を使っていた印。枠の始まりの推定に使う) と、出力トークン数 (「AI が書いた量」に使う)。
// 入力や中身は読まない
// Claude Code のログと、Cowork のセッションの中にある同じ形式のログ (.claude/projects の下だけ)
function* claudeLogFiles(sinceMs) {
  yield* walkJsonl(path.join(claudeDir(), "projects"), sinceMs);
  const mark = `${path.sep}.claude${path.sep}projects${path.sep}`;
  for (const f of walkJsonl(coworkDir(), sinceMs)) if (f.includes(mark)) yield f;
}

export function scanClaude(sinceMs) {
  const hits = [], weekly = [], activity = [];
  const usage = new Map(); // 応答の時刻。同じ応答が複数行に書かれるので message.id + requestId で 1回に数える
  for (const file of claudeLogFiles(sinceMs)) {
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
          // 週間リミット (seven_day / seven_day_opus など) は別に数えてごほうびを出す
          if (/^seven_day/.test(q.rateLimitType)) {
            const r = q.resetsAt ? epochMs(+q.resetsAt) : null;
            if (r && r > ts && r - ts <= WEEK_MS + HOUR) weekly.push({ ts, reset: r });
            continue;
          }
          if (q.rateLimitType !== "five_hour") continue;
          if (q.resetsAt) reset = epochMs(+q.resetsAt);
        } else if (WEEKLY_RE.test(text)) continue;
        reset ??= parseResetText(text, ts);
        // リセット時刻が分からない、または 5時間枠と矛盾するものは数えない (週次などの誤検出を避ける)
        if (!reset || reset <= ts || reset - ts > WINDOW_MS + 15 * 60000) continue;
        hits.push({ ts, reset });
      } else if (line.includes('"usage"') && line.includes('"type":"assistant"')) {
        const ev = parseLine(line);
        const m = ev?.message, u = m?.usage;
        if (ev?.type !== "assistant" || !u || !m.model || m.model === "<synthetic>") continue;
        const ts = Date.parse(ev.timestamp);
        const key = `${m.id}:${ev.requestId}`;
        if (!Number.isFinite(ts) || ts < sinceMs || usage.has(key)) continue;
        usage.set(key, { ts, out: u.output_tokens || 0 });
      } else if (line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true')) {
        const ev = parseLine(line);
        if (ev?.type !== "user" || ev.isSidechain) continue;
        const ts = Date.parse(ev.timestamp);
        if (Number.isFinite(ts)) activity.push(ts);
      }
    }
  }
  const cowork = scanCowork(sinceMs);
  return { hits: [...hits, ...cowork.hits], weekly: [...weekly, ...cowork.weekly], activity, usage: [...usage.values()], current: cowork.current };
}

// Cowork の audit.jsonl: リクエストごとに rate_limit_event (status / rateLimitType / resetsAt / 使用率) が入る。
// status が rejected ならリミット到達。いちばん新しいものから今の 5時間枠のリセット時刻も分かる (枠は Claude Code と共通)
export function scanCowork(sinceMs) {
  const hits = [], weekly = [];
  let current = null;
  for (const file of walkJsonl(coworkDir(), sinceMs)) {
    if (path.basename(file) !== "audit.jsonl") continue;
    for (const line of lines(file)) {
      if (!line.includes('"rate_limit_event"')) continue;
      const ev = parseLine(line);
      const info = ev?.rate_limit_info;
      const ts = Date.parse(ev?._audit_timestamp);
      if (ev?.type !== "rate_limit_event" || !info?.resetsAt || !Number.isFinite(ts) || ts < sinceMs) continue;
      const reset = epochMs(+info.resetsAt);
      if (!(reset > ts)) continue;
      if (/^seven_day/.test(info.rateLimitType || "")) {
        if (info.status === "rejected" && reset - ts <= WEEK_MS + HOUR) weekly.push({ ts, reset });
        continue;
      }
      if (info.rateLimitType !== "five_hour" || reset - ts > WINDOW_MS + 15 * 60000) continue;
      if (info.status === "rejected") hits.push({ ts, reset });
      if (!current || ts > current.at) {
        const pct = info.status === "rejected" ? 100 : Number.isFinite(info.utilization) ? Math.round(info.utilization * 100) : null;
        current = { at: ts, resetAt: reset, pct };
      }
    }
  }
  return { hits, weekly, current };
}

// ---------- Codex ----------
// token_count イベントの rate_limits に 5時間枠 (300分) と週間枠 (10080分) の使用率とリセット時刻が毎回入る。
function limitOf(rl, minutes) {
  if (!rl || typeof rl !== "object") return null;
  const c = [rl.primary, rl.secondary].filter(Boolean);
  return c.find((x) => Number(x.window_minutes) === minutes) ?? null;
}
const resetOf = (lim, ts) => (lim.resets_at != null ? epochMs(+lim.resets_at) : lim.resets_in_seconds != null ? ts + lim.resets_in_seconds * 1000 : null);

export function scanCodex(sinceMs) {
  const hits = [], weekly = [], activity = [], usage = [];
  const opened = new Map(); // 開けた枠: リセット時刻 (分単位に丸める) → 最大の使用率
  let current = null;
  for (const file of walkJsonl(path.join(codexDir(), "sessions"), sinceMs)) {
    for (const line of lines(file, offsetSince(file, sinceMs))) {
      if (line.includes('"token_count"')) {
        const ev = parseLine(line);
        const p = ev?.payload;
        if (p?.type !== "token_count") continue;
        const ts = Date.parse(ev.timestamp);
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        const lim = limitOf(p.rate_limits, 300), wk = limitOf(p.rate_limits, 10080);
        const reset = lim && resetOf(lim, ts), wreset = wk && resetOf(wk, ts);
        // 使用率そのものは送らない (使っていないときは古い数字になるため)。到達の判定とプランだけに使う
        // 使用率は同じ枠の中では増えるだけなので、枠が続いている間は最後の値がそのまま今の値になる
        // 「今の状態」は 5時間枠の値を含む記録だけで更新する。
        // limit_id が "premium" など別の利用枠の記録 (5時間枠が空) で、使用中の枠を上書きしないため
        if (lim && reset && (!current || ts > current.at)) {
          current = {
            at: ts, plan: p.rate_limits?.plan_type ?? current?.plan ?? null, resetAt: reset,
            pct: Number(lim.used_percent),
            week: wk && wreset ? { pct: Number(wk.used_percent), resetAt: wreset } : current?.week ?? null,
          };
        }
        if (lim && reset && Number(lim.used_percent) >= 100) hits.push({ ts, reset });
        if (lim && reset) {
          const key = Math.round(reset / 60000);
          const o = opened.get(key);
          const pct = Number(lim.used_percent) || 0;
          if (!o) opened.set(key, { resetAt: reset, peak: pct });
          else o.peak = Math.max(o.peak, pct);
        }
        if (wk && wreset && Number(wk.used_percent) >= 100) weekly.push({ ts, reset: wreset });
        // 応答の時刻と出力トークン数 (中身は送らない)
        const u = p.info?.last_token_usage;
        if (u && (u.input_tokens || u.output_tokens)) usage.push({ ts, out: u.output_tokens || 0 });
      } else if (line.includes('"task_started"')) {
        const ev = parseLine(line);
        if (ev?.payload?.type !== "task_started") continue;
        const ts = Date.parse(ev.timestamp);
        if (Number.isFinite(ts)) activity.push(ts);
      }
    }
  }
  // リセット時刻が数秒〜数十秒ぶれて同じ枠が分かれることがあるので、15分以内はまとめる
  const merged = [];
  for (const o of [...opened.values()].sort((a, b) => a.resetAt - b.resetAt)) {
    const last = merged[merged.length - 1];
    if (last && o.resetAt - last.resetAt < 15 * 60000) { last.peak = Math.max(last.peak, o.peak); last.resetAt = Math.max(last.resetAt, o.resetAt); }
    else merged.push({ ...o });
  }
  return { hits, weekly, activity, current, usage, opened: merged };
}

// ---------- plan ----------
// 課金プランごとにランキングを分けるため、プランの種類だけを読む (メールや組織 ID は読まない)
export function claudePlan() {
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
  const a = readJson(file, {})?.oauthAccount;
  if (!a) return null;
  const tier = String(a.userRateLimitTier || a.organizationRateLimitTier || "");
  const type = String(a.organizationType || "");
  const m = tier.match(/max_(\d+)x/);
  if (/max/.test(type) || m) return m ? `max_${m[1]}x` : "max";
  if (/pro/.test(type)) return "pro";
  if (/team/.test(type)) return "team";
  if (/enterprise/.test(type)) return "enterprise";
  return type ? type.replace(/^claude_/, "").slice(0, 20) : null;
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

// Claude Code の今の 5時間枠がいつリセットされるか (推定)。
// 枠は「前の枠が終わったあと最初に使った時刻」から 5時間。リミットに当たった枠は正確なリセット時刻で合わせる
export function claudeWindowEnd(times, hits) {
  const acts = [...times].sort((a, b) => a - b);
  const resets = hits.map((h) => h.reset).sort((a, b) => a - b);
  let end = -Infinity, exact = false;
  for (const t of acts) {
    if (t < end) continue;
    end = t + WINDOW_MS;
    exact = false;
    const r = resets.find((x) => x > t && x <= t + WINDOW_MS + 15 * 60000);
    if (r) { end = r; exact = true; }
  }
  return { resetAt: end, exact };
}

// Claude Code の開けた枠をすべて割り出す (claudeWindowEnd と同じ考え方で、枠ごとに返す)
export function claudeWindows(times, hits) {
  const acts = [...times].sort((a, b) => a - b);
  const resets = hits.map((h) => h.reset).sort((a, b) => a - b);
  const out = [];
  let end = -Infinity;
  for (const t of acts) {
    if (t < end) continue;
    const r = resets.find((x) => x > t && x <= t + WINDOW_MS + 15 * 60000);
    end = r ?? t + WINDOW_MS;
    out.push({ resetAt: end, exact: !!r, peak: r ? 100 : null });
  }
  return out;
}

// 開けた枠の一覧 (使い切ったかどうかに関係なく)。Codex は正確、Claude Code は推定 (中継があれば今の枠は正確)
function openedSessions(claude, codex, since) {
  const now = Date.now();
  const out = [];
  for (const o of codex.opened) out.push({ tool: "codex", startAt: o.resetAt - WINDOW_MS, resetAt: o.resetAt, peakPct: o.peak, exact: true });
  const cu = readJson(CLAUDE_USAGE_FILE, null);
  for (const w of claudeWindows([...claude.activity, ...claude.usage.map((u) => u.ts)], claude.hits)) {
    const relay = cu?.five && Math.abs(cu.five.resetAt - w.resetAt) < 2 * HOUR && cu.five.resetAt > now ? cu.five : null;
    const resetAt = relay?.resetAt ?? w.resetAt;
    out.push({ tool: "claude", startAt: resetAt - WINDOW_MS, resetAt, peakPct: w.peak ?? relay?.pct ?? null, exact: w.exact || !!relay });
  }
  return out.filter((o) => o.resetAt >= since);
}

// 週間リミットの到達はリセット時刻ごとに 1つ
function toWeekly(tool, hits) {
  const out = [];
  for (const h of [...hits].sort((a, b) => a.reset - b.reset)) {
    const last = out[out.length - 1];
    if (last && h.reset - last.resetAt < 6 * HOUR) { last.hitAt = Math.min(last.hitAt, h.ts); continue; }
    out.push({ tool, hitAt: h.ts, resetAt: h.reset });
  }
  return out;
}

// 次のリセット時刻 (今まさに枠の途中のものだけ)。Codex はログに書かれた正確な値、Claude Code は推定
function nextResets(claude, codex) {
  const now = Date.now();
  const out = {};
  // ステータスラインの中継 (オンの人だけ) があれば、Claude Code も正確な使用率とリセット時刻
  const cu = readJson(CLAUDE_USAGE_FILE, null);
  if (cu?.five?.resetAt > now) out.claude = { resetAt: cu.five.resetAt, exact: true, pct: cu.five.pct, at: cu.at };
  // Cowork のログにある今の枠 (正確なリセット時刻。使用率は 90% を超えたときなどにだけ入る)
  else if (claude.current?.resetAt > now) out.claude = { resetAt: claude.current.resetAt, exact: true, pct: claude.current.pct, at: claude.current.at };
  else {
    const c = claudeWindowEnd([...claude.activity, ...claude.usage.map((u) => u.ts)], claude.hits);
    if (c.resetAt > now) out.claude = c;
  }
  if (cu?.week?.resetAt > now) (out.claude ??= {}).week = cu.week;
  if (codex.current?.resetAt > now) out.codex = { resetAt: codex.current.resetAt, exact: true, pct: codex.current.pct, at: codex.current.at };
  if (codex.current?.week?.resetAt > now) (out.codex ??= {}).week = codex.current.week;
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
  const relayed = (readJson(CLAUDE_USAGE_FILE, {}).weeklyHits ?? []).map((h) => ({ ts: h.hitAt, reset: h.resetAt }));
  const weeklyHits = [...toWeekly("claude", [...claude.weekly, ...relayed]), ...toWeekly("codex", codex.weekly)].filter((w) => w.resetAt >= since);
  return {
    client: { version: VERSION, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: process.platform },
    windows,
    weeklyHits,
    plans: { claude: claudePlan(), codex: codex.current?.plan ?? null },
    nextReset: nextResets(claude, codex),
    sessions: openedSessions(claude, codex, since),
    output: outputByDay(claude, codex, since),
  };
}

// 「AI が書いた量」: 出力トークン数を、その PC の日付ごと・ツールごとに足したもの { "2026-10-16": { claude, codex } }
export function outputByDay(claude, codex, since) {
  const out = {};
  for (const [tool, src] of [["claude", claude], ["codex", codex]]) {
    for (const e of src.usage) {
      if (e.ts < since || !e.out) continue;
      const day = new Date(e.ts).toLocaleDateString("en-CA");
      const d = (out[day] ??= { claude: 0, codex: 0 });
      d[tool] += e.out;
    }
  }
  return out;
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
  if (!cfg.token) { if (!quiet) console.error(L("まだセットアップされていません: ratelimit-world setup", "Not set up yet. Run: ratelimit-world setup")); return false; }
  // hook は毎ターン走るので、直近に送っていれば省略する (リミット到達時は必ず送る)
  if (reason === "hook" && cfg.lastSyncAt && Date.now() - cfg.lastSyncAt < 20_000) return true;
  // 「AI が書いた量」を始めた版では、最初の 1回だけ過去 60日分の出力トークン数も送る
  if (!cfg.outputSince) full = true;
  const payload = collect(full ? 60 : 3);
  // プロンプト送信の瞬間に「今使い始めた」と伝える (ログに書かれる前でも再開時刻が分かるように)
  if (active) payload.active = { [active]: Date.now() };
  try {
    const r = await api(cfg, "POST", "/api/sync", payload);
    // サイトで選んでいる言語に表示を合わせる
    saveConfig({ ...loadConfig(), lastSyncAt: Date.now(), ...(r.lang ? { lang: r.lang } : {}), ...(full ? { outputSince: loadConfig().outputSince ?? Date.now() } : {}) });
    // サイトが正式なドメインに移ったら、送り先を切り替える (仮のアドレス *.workers.dev から ratelimit.world へだけ)
    if (r.server === DEFAULT_SERVER && cfg.server !== DEFAULT_SERVER && /\.workers\.dev$/.test(new URL(cfg.server).hostname)) {
      saveConfig({ ...loadConfig(), server: DEFAULT_SERVER });
      log(`server moved to ${DEFAULT_SERVER}`);
    }
    if (r.status) writeJson(STATUS_FILE, { ...r.status, at: Date.now() });
    // 自動ウォームアップ: 次のリセット時刻に合わせて予約し直す (オフなら外す)
    if (r.warmup) { try { scheduleWarmups(r.warmup, payload.nextReset); } catch (e) { log(`warmup: ${e.message}`); } }
    // ダッシュボードの「Claude Code の使用率も表示する」に合わせて、ステータスラインの中継を入れる / 外す
    if (typeof r.statusline === "boolean" && r.statusline !== !!loadConfig().statusline) {
      try { setStatusline(r.statusline); log(`statusline relay ${r.statusline ? "on" : "off"}`); } catch (e) { log(`statusline: ${e.message}`); }
    }
    log(`sync ok (${reason}) windows=${payload.windows.length}`);
    // すでに入れている人も、Cowork を使っていれば 5分ごとの送信を足す (1回だけ)
    if (process.platform === "darwin" && !fs.existsSync(timerPlist()) && fs.existsSync(coworkDir()) && realpath(SELF) === realpath(INSTALLED_SCRIPT)) {
      if (installTimer()) log("timer installed (cowork)");
    }
    if (!quiet) console.log(L(`送信しました: ${payload.windows.length} 件。今日 ${r.today ?? "?"} / ${r.goal ?? "?"} 枠、${r.streak ?? 0} 日連続`, `Sent ${payload.windows.length} windows. Today ${r.today ?? "?"}/${r.goal ?? "?"}, ${r.streak ?? 0}-day streak`));
    return true;
  } catch (e) {
    log(`sync failed (${reason}): ${e.message}`);
    if (!quiet) console.error(L(`送信に失敗しました: ${e.message}`, `Failed to send: ${e.message}`));
    return false;
  } finally {
    await maybeUpdate().catch((e) => log(`update failed: ${e.message}`));
  }
}

// ---------- 自動更新 ----------
// サーバーが配っている版の SHA-256 (/cli.json) と自分を比べ、違えば新しい版に置き換える。
// 6時間に 1回だけ確認する。ダウンロードしたものが /cli.json の値と一致したときだけ置き換える
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
async function maybeUpdate() {
  const cfg = loadConfig();
  if (!cfg.server || process.env.RATELIMIT_WORLD_NO_UPDATE) return;
  if (realpath(SELF) !== realpath(INSTALLED_SCRIPT)) return; // 開発中のファイルは書き換えない
  if (cfg.lastUpdateCheck && Date.now() - cfg.lastUpdateCheck < 6 * HOUR) return;
  saveConfig({ ...cfg, lastUpdateCheck: Date.now() });
  const get = (p) => fetch(new URL(p, cfg.server), { signal: AbortSignal.timeout(10_000) });
  const meta = await get("/cli.json").then((r) => (r.ok ? r.json() : null));
  if (!meta?.sha256 || meta.sha256 === sha256(fs.readFileSync(SELF))) return;
  const res = await get("/cli.mjs");
  if (!res.ok) return;
  const body = Buffer.from(await res.arrayBuffer());
  if (sha256(body) !== meta.sha256) { log("update skipped: checksum mismatch"); return; }
  const tmp = `${INSTALLED_SCRIPT}.new`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, INSTALLED_SCRIPT); // 置き換えは一瞬で済ませる (途中の状態を残さない)
  log(`updated ${VERSION} -> ${meta.version}`);
}

// ---------- timer (Mac) ----------
// Cowork には hooks がないので、Mac では 5分ごとに自分で送る (launchd)。ログイン中ずっと動き、スリープ中は止まる
const TIMER_LABEL = "world.ratelimit.sync";
const timerPlist = () => path.join(os.homedir(), "Library", "LaunchAgents", `${TIMER_LABEL}.plist`);

function installTimer() {
  if (process.platform !== "darwin") return false;
  const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TIMER_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(INSTALLED_SCRIPT)}</string><string>sync</string><string>--quiet</string><string>--reason</string><string>timer</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardInPath</key><string>/dev/null</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(timerPlist()), { recursive: true });
  fs.writeFileSync(timerPlist(), plist);
  const uid = String(process.getuid());
  try { execFileSync("launchctl", ["bootout", `gui/${uid}/${TIMER_LABEL}`], { stdio: "ignore" }); } catch {}
  try { execFileSync("launchctl", ["bootstrap", `gui/${uid}`, timerPlist()], { stdio: "ignore" }); } catch (e) { log(`timer: ${e.message}`); }
  return true;
}

function removeTimer() {
  if (process.platform !== "darwin") return;
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${TIMER_LABEL}`], { stdio: "ignore" }); } catch {}
  fs.rmSync(timerPlist(), { force: true });
}

// ---------- auto warm-up (Mac) ----------
// リセットの瞬間に、Claude Code / Codex へ短い問い合わせを 1回送って次の 5時間枠を始める。
// 送信のたびに、サーバーから受け取ったリセット時刻に合わせて launchd に 1回だけの予約を入れ直す (スリープ中なら起きたときに動く)
const WARMUP_TOOLS = ["claude", "codex"];
const warmupLabel = (tool) => `world.ratelimit.warmup.${tool}`;
const warmupPlist = (tool) => path.join(os.homedir(), "Library", "LaunchAgents", `${warmupLabel(tool)}.plist`);

// コマンドの場所: hooks から呼ばれたときの PATH と、よく入る場所を探す (launchd から動くときは PATH がほぼ空なので)
function findBin(name) {
  const dirs = [...(process.env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// 送らない時間帯か。'23:00-07:00' のように日をまたいでもよい
export function inQuiet(quiet, d = new Date()) {
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(quiet || "");
  if (!m) return false;
  const now = d.getHours() * 60 + d.getMinutes(), a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a < b ? now >= a && now < b : now >= a || now < b;
}

function removeWarmup(tool) {
  if (process.platform !== "darwin") return;
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${warmupLabel(tool)}`], { stdio: "ignore" }); } catch {}
  fs.rmSync(warmupPlist(tool), { force: true });
}

function scheduleWarmups(setting, nextReset) {
  if (process.platform !== "darwin") return;
  const cfg = loadConfig();
  const planned = { ...(cfg.warmupPlanned || {}) };
  for (const tool of WARMUP_TOOLS) {
    if (!setting?.on) { if (planned[tool] || fs.existsSync(warmupPlist(tool))) removeWarmup(tool); delete planned[tool]; continue; }
    const resetAt = nextReset?.[tool]?.resetAt;
    const bin = findBin(tool);
    if (!bin || !(resetAt > Date.now())) continue;
    if (planned[tool] === resetAt && fs.existsSync(warmupPlist(tool))) continue;
    // リセットの次の分に起こす (launchd は分単位)
    const at = new Date(Math.ceil((resetAt + 5000) / 60000) * 60000);
    const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const PATH = [path.dirname(process.execPath), path.dirname(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${warmupLabel(tool)}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(INSTALLED_SCRIPT)}</string><string>warmup</string><string>${tool}</string><string>${resetAt}</string></array>
  <key>StartCalendarInterval</key><dict><key>Month</key><integer>${at.getMonth() + 1}</integer><key>Day</key><integer>${at.getDate()}</integer><key>Hour</key><integer>${at.getHours()}</integer><key>Minute</key><integer>${at.getMinutes()}</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>StandardInPath</key><string>/dev/null</string>
</dict></plist>
`;
    removeWarmup(tool);
    fs.mkdirSync(path.dirname(warmupPlist(tool)), { recursive: true });
    fs.writeFileSync(warmupPlist(tool), plist);
    try { execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, warmupPlist(tool)], { stdio: "ignore" }); } catch (e) { log(`warmup schedule ${tool}: ${e.message}`); continue; }
    planned[tool] = resetAt;
    log(`warmup ${tool} scheduled at ${at.toISOString()}`);
  }
  saveConfig({ ...loadConfig(), warmupPlanned: planned, warmup: setting ?? null });
}

// 予約の時刻に launchd から呼ばれる: 条件を確かめて 1回だけ送り、結果をすぐサーバーへ送る
async function warmup(tool, resetAt) {
  const cfg = loadConfig();
  const finish = (msg) => {
    log(`warmup ${tool}: ${msg}`);
    // 自分の予約を外す (同じ日時に来月また動かないように)。自分を止めないよう、別のプロセスで外す
    fs.rmSync(warmupPlist(tool), { force: true });
    try { spawn("launchctl", ["bootout", `gui/${process.getuid()}/${warmupLabel(tool)}`], { detached: true, stdio: "ignore" }).unref(); } catch {}
  };
  if (!WARMUP_TOOLS.includes(tool) || !(resetAt > 0)) return finish("bad arguments");
  if (!cfg.warmup?.on) return finish("off");
  if (inQuiet(cfg.warmup.quiet)) return finish("quiet hours");
  if (Date.now() < resetAt) return finish("too early");
  // リセット後にもう使い始めていれば送らない (その時点で新しい枠は始まっている)
  const scan = tool === "claude" ? scanClaude(resetAt) : scanCodex(resetAt);
  if (scan.activity.some((t) => t >= resetAt) || scan.usage.some((u) => u.ts >= resetAt)) return finish("already in use");
  const bin = findBin(tool);
  if (!bin) return finish("not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-warmup-"));
  const args = tool === "claude"
    ? ["-p", "Reply with OK only.", "--model", "haiku", "--output-format", "json"]
    : ["exec", "--skip-git-repo-check", "-s", "read-only", "-c", 'model_reasoning_effort="low"', "Reply with OK only. Do not run any commands."];
  const r = spawnSync(bin, args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], timeout: 5 * 60000 });
  fs.rmSync(dir, { recursive: true, force: true });
  await sync({ quiet: true, reason: "warmup" });
  finish(r.error ? `failed: ${r.error.message}` : `sent (exit ${r.status})`);
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
  if (!s) throw new Error(L(`${file} を読めませんでした (JSON の形式を確認してください)`, `Could not read ${file} (check that it is valid JSON)`));
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

// ---------- ステータスラインの中継 (オン/オフ式) ----------
// Claude Code はステータスラインに rate_limits (5時間枠・週間枠の使用率とリセット時刻) を渡す。
// 間に入ってそれを記録し、元のステータスラインがあれば同じ入力で呼んで、表示はそのまま出す
const toMs = (v) => (v == null ? null : typeof v === "number" ? epochMs(v) : /^\d+$/.test(String(v)) ? epochMs(+v) : Date.parse(v) || null);

export function setStatusline(on) {
  const file = path.join(claudeDir(), "settings.json");
  const s = readJson(file, null);
  if (!s) throw new Error(`cannot read ${file}`);
  const cfg = loadConfig();
  const ours = JSON.stringify(s.statusLine ?? "").includes(HOOK_MARK);
  if (on && !ours) {
    if (s.statusLine) cfg.prevClaudeStatusLine = s.statusLine;
    s.statusLine = { ...(s.statusLine ?? {}), type: "command", command: `${nodeCmd()} "${INSTALLED_SCRIPT}" statusline` };
  } else if (!on && ours) {
    if (cfg.prevClaudeStatusLine) s.statusLine = cfg.prevClaudeStatusLine; else delete s.statusLine;
    delete cfg.prevClaudeStatusLine;
    try { fs.rmSync(CLAUDE_USAGE_FILE); } catch {}
  }
  writeJson(file, s);
  saveConfig({ ...cfg, statusline: on });
}

function recordClaudeUsage(input) {
  const rl = input?.rate_limits;
  if (!rl) return;
  const now = Date.now();
  const cur = readJson(CLAUDE_USAGE_FILE, {});
  const pick = (x) => (x && x.used_percentage != null && toMs(x.resets_at) ? { pct: Number(x.used_percentage), resetAt: toMs(x.resets_at) } : null);
  const next = { at: now, five: pick(rl.five_hour), week: pick(rl.seven_day), weeklyHits: cur.weeklyHits ?? [] };
  // 週間枠が 100% になったら到達として覚えておく (次の送信で届ける)
  const w = next.week;
  if (w && w.pct >= 100 && !next.weeklyHits.some((h) => Math.abs(h.resetAt - w.resetAt) < HOUR)) next.weeklyHits.push({ hitAt: now, resetAt: w.resetAt });
  next.weeklyHits = next.weeklyHits.filter((h) => h.resetAt > now - 30 * DAY);
  writeJson(CLAUDE_USAGE_FILE, next);
}

async function statusline() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data = null;
  try { data = JSON.parse(input); } catch {}
  try { recordClaudeUsage(data); } catch {}
  const seg = statusSegment(data?.rate_limits);
  const prev = loadConfig().prevClaudeStatusLine;
  if (prev?.command) {
    // 元のステータスラインの出力の後ろに、ratelimit.world の 1区切りを足す
    const out = await new Promise((resolve) => {
      const child = spawn(prev.command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
      let buf = "";
      child.stdout.on("data", (d) => (buf += d));
      child.on("error", () => resolve(buf));
      child.on("close", () => resolve(buf));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
    const text = out.replace(/\s+$/, "");
    process.stdout.write(text && seg ? `${text} │ ${seg}` : text || seg);
    return;
  }
  if (seg) process.stdout.write(seg);
}

// ---------- PC で常に目に入る表示 (ステータスライン・メニューバー) ----------
// 残り時間: 3h52m / 12m / <1m
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "<1m";
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const NAMES = { claude: "Claude", codex: "Codex" };

// 保存してある状態に、今の時刻を当てはめる (リセット時刻を過ぎていれば「再開待ち」)
function liveTools(liveClaude) {
  const st = readJson(STATUS_FILE, null);
  if (!st) return null;
  const now = Date.now();
  const tools = { ...st.tools };
  // Claude Code は中継で受け取ったばかりの値があれば、そちらが新しい
  const five = liveClaude?.five_hour;
  const cr = five ? toMs(five.resets_at) : null;
  if (cr && cr > now && tools.claude?.state !== "weekly" && tools.claude?.state !== "limited") {
    tools.claude = { state: "using", resetAt: cr, pct: Number(five.used_percentage), exact: true };
  }
  for (const [k, t] of Object.entries(tools)) {
    if ((t.state === "limited" || t.state === "using" || t.state === "weekly") && t.resetAt <= now) tools[k] = { state: "ready", since: t.resetAt };
  }
  return { ...st, tools, now };
}

function statusSegment(liveClaude) {
  const st = liveTools(liveClaude);
  if (!st) return "";
  const parts = [`🔥${st.streak} ${st.today}/${st.goal}${L("枠", "")}`];
  for (const tool of ["claude", "codex"]) {
    const t = st.tools[tool];
    if (!t || t.state === "idle") continue;
    if (t.state === "ready") parts.push(`${NAMES[tool]} ⚡GO`);
    else if (t.state === "weekly") parts.push(`${NAMES[tool]} 🏆${dur(t.resetAt - st.now)}`);
    else parts.push(`${NAMES[tool]}${t.pct != null ? ` ${L("残", "")}${100 - Math.round(t.pct)}%` : ""} ⏳${t.exact === false ? "~" : ""}${dur(t.resetAt - st.now)}`);
  }
  return parts.join(" · ");
}

// SwiftBar のプラグインとして 1分ごとに呼ばれ、メニューバーの表示を出す
function menubar() {
  const cfg = loadConfig();
  const st = liveTools(null);
  if (!st) {
    console.log(`🔥\n---\n${L("まだ記録がありません。Claude Code か Codex を使うと表示されます", "No data yet. Use Claude Code or Codex to see it here")}`);
    return;
  }
  const tools = ["claude", "codex"].map((k) => [k, st.tools[k]]).filter(([, t]) => t);
  const ready = tools.some(([, t]) => t.state === "ready");
  const timed = tools.filter(([, t]) => t.resetAt > st.now && t.state !== "weekly").map(([, t]) => t.resetAt).sort((a, b) => a - b);
  const title = ready ? `🔥${st.streak} ⚡GO` : timed.length ? `🔥${st.streak} ⏳${dur(timed[0] - st.now)}` : `🔥${st.streak}`;
  const lines = [title, "---", L(`🔥 ${st.streak}日連続 · 今日 ${st.today}/${st.goal} 枠`, `🔥 ${st.streak}-day streak · today ${st.today}/${st.goal}`)];
  for (const [tool, t] of tools) {
    const name = tool === "claude" ? "Claude Code" : "Codex";
    const pct = t.pct != null ? ` ${L(`残り ${100 - Math.round(t.pct)}%`, `${100 - Math.round(t.pct)}% left`)}` : "";
    if (t.state === "ready") lines.push(L(`${name}  ⚡ リセット済み — 今すぐ再開`, `${name}  ⚡ reset — restart now`) + " | color=#16A34A");
    else if (t.state === "weekly") lines.push(L(`${name}  🏆 週間リミット中（${new Date(t.resetAt).toLocaleString()} まで）`, `${name}  🏆 weekly limit (until ${new Date(t.resetAt).toLocaleString()})`));
    else if (t.state === "idle") lines.push(L(`${name}  待機中`, `${name}  idle`));
    else lines.push(L(`${name}${pct}  ${hm(t.resetAt)} にリセット（あと ${dur(t.resetAt - st.now)}${t.exact === false ? "・推定" : ""}）`, `${name}${pct}  resets ${hm(t.resetAt)} (in ${dur(t.resetAt - st.now)}${t.exact === false ? ", est." : ""})`));
  }
  lines.push("---");
  if (cfg.server) lines.push(`${L("ダッシュボードを開く", "Open dashboard")} | href=${cfg.server}/me`);
  lines.push(`${L("今すぐ送信", "Sync now")} | bash=${process.execPath} param1=${INSTALLED_SCRIPT} param2=sync param3=--quiet terminal=false refresh=true`);
  lines.push(`${L("最終更新", "Updated")} ${hm(st.at)} | size=11`);
  console.log(lines.join("\n"));
}

// SwiftBar のプラグインフォルダに、1分ごとに更新するプラグインを置く
function menubarInstall() {
  let dir = null;
  try { dir = execFileSync("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  if (!dir) {
    dir = path.join(HOME, "swiftbar");
    execFileSync("defaults", ["write", "com.ameba.SwiftBar", "PluginDirectory", dir]);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ratelimit-world.1m.sh");
  fs.writeFileSync(file, `#!/bin/sh
# <swiftbar.title>ratelimit.world</swiftbar.title>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
exec "${process.execPath}" "${INSTALLED_SCRIPT}" menubar
`);
  fs.chmodSync(file, 0o755);
  console.log(L(`✅ メニューバーのプラグインを置きました (${file})。SwiftBar を起動すると表示されます`, `✅ Added the menu bar plugin (${file}). Launch SwiftBar to see it`));
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
    try { prev = JSON.parse(m[1]); } catch { throw new Error(L(`${file} の notify を読めませんでした。手動で設定してください`, `Could not read notify in ${file}. Please set it up manually`)); }
    if (!JSON.stringify(prev).includes(HOOK_MARK)) cfg.prevCodexNotify = prev;
    fs.copyFileSync(file, `${file}.ratelimit-world.bak`);
    text = text.replace(NOTIFY_RE, `notify = ${JSON.stringify(ours)}`);
  } else if (/^\s*notify\s*=/m.test(text)) {
    throw new Error(L(`${file} の notify が複数行で書かれているため自動設定できません`, `notify in ${file} spans multiple lines, so it can't be set up automatically`));
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
  console.log(L(`🔥 ratelimit.world のセットアップ (${cfg.server})\n`, `🔥 Setting up ratelimit.world (${cfg.server})\n`));
  const start = await api({ server: cfg.server }, "POST", "/api/cli/start", { platform: process.platform });
  console.log(L(`ブラウザでログインして、このコードを確認してください: ${start.userCode}\n  ${start.verifyUrl}\n`, `Log in in your browser and confirm this code: ${start.userCode}\n  ${start.verifyUrl}\n`));
  if (!process.env.RATELIMIT_WORLD_NO_BROWSER) openBrowser(start.verifyUrl);
  const deadline = Date.now() + 10 * 60 * 1000;
  let token = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await api({ server: cfg.server }, "POST", "/api/cli/poll", { deviceCode: start.deviceCode });
      if (r.token) {
        token = r.token; cfg.login = r.login;
        // ここから先はサイトで選んでいる言語で表示する
        if (r.lang) { cfg.lang = r.lang; ja = r.lang === "ja"; }
        break;
      }
    } catch (e) {
      if (/expired|invalid/.test(e.message)) throw e;
    }
  }
  if (!token) throw new Error(L("時間切れです。もう一度 setup を実行してください", "Timed out. Run setup again"));
  cfg.token = token;

  fs.mkdirSync(HOME, { recursive: true });
  if (realpath(SELF) !== realpath(INSTALLED_SCRIPT)) fs.copyFileSync(SELF, INSTALLED_SCRIPT);
  saveConfig(cfg);
  console.log(L(`✅ @${cfg.login} としてログインしました`, `✅ Logged in as @${cfg.login}`));

  const c = installClaudeHooks();
  console.log(L(`✅ Claude Code の hooks を登録しました (${c})`, `✅ Added Claude Code hooks (${c})`));
  if (installTimer()) console.log(L("✅ 5分ごとに自動で送る設定をしました (Cowork など hooks のないアプリ用)", "✅ Set up a sync every 5 minutes (for apps without hooks, like Cowork)"));
  try {
    const x = installCodexNotify(cfg);
    if (x) console.log(L(`✅ Codex の notify を登録しました (${x})${cfg.prevCodexNotify ? "。元の notify も引き続き呼ばれます" : ""}`, `✅ Added Codex notify (${x})${cfg.prevCodexNotify ? ". Your existing notify still runs" : ""}`));
  } catch (e) { console.log(`⚠️  ${e.message}`); }
  saveConfig(cfg);

  console.log(L("\n過去 60 日分のログを送ります…", "\nSending the last 60 days…"));
  await sync({ full: true, quiet: true });
  printHistory(collect(60).windows);
  console.log(L("\n🎉 準備完了！ ブラウザに戻って、通知を ON にしてください。あとは普段どおり使うだけです。", "\n🎉 All set! Go back to your browser and turn on notifications. Then just code as usual."));
}

// setup の最後に、これまでの記録をひと目で見せる
function printHistory(windows) {
  const c = process.stdout.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_, s) => s;
  const byTool = (t) => windows.filter((w) => w.tool === t).length;
  const delays = windows.filter((w) => w.resumedAt).map((w) => w.resumedAt - w.resetAt).filter((d) => d >= 0 && d <= 3 * HOUR);
  const lost = Math.round(delays.reduce((a, b) => a + b, 0) / 60000);
  console.log(`\n${c("1", L("これまでの記録 (過去60日)", "Your last 60 days"))}`);
  console.log(`  ${L("使い切った枠  ", "windows used ")}  ${c("1;35", windows.length)}  (Claude Code ${byTool("claude")} / Codex ${byTool("codex")})`);
  if (delays.length) {
    console.log(L(
      `  平均の出遅れ   ${c("1;33", Math.round(lost / delays.length) + " 分")}  → 合計 ${Math.floor(lost / 60)}時間${lost % 60}分 を取りこぼしていました`,
      `  avg. late      ${c("1;33", Math.round(lost / delays.length) + " min")}  → ${Math.floor(lost / 60)}h ${lost % 60}m lost in total`));
  }
  // 直近14日を 1日1文字で: 0枠 · / 1枠 ▂ / 2枠 ▅ / 3枠以上 █
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY).toDateString();
    const n = windows.filter((w) => new Date(w.hitAt).toDateString() === d).length;
    days.push(n === 0 ? c("2", "·") : c("35", n === 1 ? "▂" : n === 2 ? "▅" : "█"));
  }
  console.log(`  ${L("直近14日      ", "last 14 days  ")} ${days.join(" ")}`);
}

function uninstall() {
  try { setStatusline(false); } catch {}
  // メニューバー (SwiftBar) のプラグインも外す
  try {
    const dir = execFileSync("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    fs.rmSync(path.join(dir, "ratelimit-world.1m.sh"), { force: true });
  } catch {}
  const cfg = loadConfig();
  removeClaudeHooks();
  removeCodexNotify(cfg);
  removeTimer();
  for (const tool of WARMUP_TOOLS) removeWarmup(tool);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(L("hooks / notify を外し、~/.ratelimit-world を削除しました", "Removed the hooks / notify and deleted ~/.ratelimit-world"));
}

function status() {
  const cfg = loadConfig();
  const p = collect(7);
  const fmt = (t) => (t ? new Date(t).toLocaleString() : "-");
  console.log(L(
    `サーバー: ${cfg.server ?? "(未設定)"}  ログイン: ${cfg.login ? "@" + cfg.login : "(未ログイン)"}  最終送信: ${fmt(cfg.lastSyncAt)}`,
    `Server: ${cfg.server ?? "(not set)"}  Login: ${cfg.login ? "@" + cfg.login : "(not logged in)"}  Last sync: ${fmt(cfg.lastSyncAt)}`));
  console.log(L(`\n直近7日のリミット到達: ${p.windows.length} 回`, `\nLimits hit in the last 7 days: ${p.windows.length}`));
  for (const w of p.windows) {
    const mins = w.resumedAt ? Math.round((w.resumedAt - w.resetAt) / 60000) : null;
    const late = mins != null ? L(`${mins}分後に再開`, `restarted ${mins} min later`) : L("未再開", "not restarted");
    console.log(L(`  ${w.tool.padEnd(6)} 到達 ${fmt(w.hitAt)} → リセット ${fmt(w.resetAt)} (${late})`, `  ${w.tool.padEnd(6)} hit ${fmt(w.hitAt)} → reset ${fmt(w.resetAt)} (${late})`));
  }
  if (p.weeklyHits.length) console.log(`\n🏆 ${L("週間リミット到達", "Weekly limits hit")}: ${p.weeklyHits.map((w) => `${w.tool} ${fmt(w.hitAt)}`).join(", ")}`);
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
    else if (cmd === "statusline") await statusline();
    else if (cmd === "menubar") (argv[1] === "install" ? menubarInstall() : menubar());
    else if (cmd === "scan") console.log(JSON.stringify(collect(Number(flag("--days")) || 7), null, 2));
    else if (cmd === "status") status();
    else if (cmd === "warmup") await warmup(argv[1], Number(argv[2]));
    else if (cmd === "uninstall") uninstall();
    else console.log(L(
      `ratelimit-world ${VERSION}\n\n  setup [--server URL]  ログインして hooks を登録\n  sync [--full]         今すぐ送信\n  status                直近の到達と送信状況\n  menubar install       Mac のメニューバー (SwiftBar) に表示\n  scan [--days N]       送る内容を表示 (通信なし)\n  uninstall             hooks を外して削除`,
      `ratelimit-world ${VERSION}\n\n  setup [--server URL]  log in and add hooks\n  sync [--full]         send now\n  status                recent limits and sync status\n  menubar install       show in the Mac menu bar (SwiftBar)\n  scan [--days N]       show what would be sent (no network)\n  uninstall             remove hooks and delete local data`));
  } catch (e) {
    // hook から呼ばれたときに Claude Code / Codex を止めないよう、失敗は記録だけして終わる
    if (cmd === "hook" || cmd === "statusline") log(`${cmd} error: ${e.message}`);
    else { console.error(`${L("エラー", "Error")}: ${e.message}`); process.exitCode = 1; }
  }
}

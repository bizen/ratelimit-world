// サーバーで組み立てる HTML。見た目は public/style.css、動きは public/app.js、文言は i18n.js。
// 各ページは ctx = { user, lang, t, path } を受け取る (t は翻訳関数)
import { TOOL_NAME, addDays, localTime, comboXp, moodOf, WINDOW_MS } from "./logic.js";
import { clientStrings, tierName, fmtWhen, leagueName } from "./i18n.js";
import { TIER_EMOJI } from "./league.js";

// 課金プランの表示名。CLI が送ってくる値 → 人が読める名前 (固有名詞なので言語で変えない)
const PLAN_NAMES = {
  claude: { pro: "Claude Pro", max: "Claude Max", max_5x: "Claude Max 5x", max_20x: "Claude Max 20x", team: "Claude Team", enterprise: "Claude Enterprise", unknown: null },
  codex: { free: "ChatGPT Free", plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Business", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu", unknown: null },
};
export const planName = (ctx, tool, plan) =>
  PLAN_NAMES[tool][plan || "unknown"] ?? (plan && plan !== "unknown" ? `${tool === "claude" ? "Claude" : "ChatGPT"} ${plan}` : ctx.t(`plan.unknown.${tool}`));
const planBadges = (ctx, u) => [["claude", u.claude_plan], ["codex", u.codex_plan]].filter(([, p]) => p).map(([tool, p]) => `<span class="plan">${esc(planName(ctx, tool, p))}</span>`).join("");

// ツールのアイコン。Claude Code は起動画面の Clawd をドット絵にしたもの、Codex は ChatGPT のロゴを近似したもの。
// どちらも各社の商標なので、正式に使うなら公式素材に差し替える
const TOOL_ICON = {
  claude: `<span class="tool-icon"><svg viewBox="0 0 16 10" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><rect x="2" y="0" width="1.02" height="2.04"/><rect x="2" y="2" width="1.02" height="2.04"/><rect x="3" y="0" width="1.02" height="2.04"/><rect x="4" y="0" width="1.02" height="2.04"/><rect x="3" y="2" width="1.02" height="2.04"/><rect x="5" y="0" width="1.02" height="2.04"/><rect x="6" y="0" width="1.02" height="2.04"/><rect x="6" y="2" width="1.02" height="2.04"/><rect x="5" y="2" width="1.02" height="2.04"/><rect x="7" y="0" width="1.02" height="2.04"/><rect x="8" y="0" width="1.02" height="2.04"/><rect x="8" y="2" width="1.02" height="2.04"/><rect x="7" y="2" width="1.02" height="2.04"/><rect x="9" y="0" width="1.02" height="2.04"/><rect x="10" y="0" width="1.02" height="2.04"/><rect x="10" y="2" width="1.02" height="2.04"/><rect x="9" y="2" width="1.02" height="2.04"/><rect x="11" y="0" width="1.02" height="2.04"/><rect x="12" y="0" width="1.02" height="2.04"/><rect x="12" y="2" width="1.02" height="2.04"/><rect x="13" y="0" width="1.02" height="2.04"/><rect x="13" y="2" width="1.02" height="2.04"/><rect x="0" y="4" width="1.02" height="2.04"/><rect x="1" y="4" width="1.02" height="2.04"/><rect x="2" y="4" width="1.02" height="2.04"/><rect x="2" y="6" width="1.02" height="2.04"/><rect x="3" y="4" width="1.02" height="2.04"/><rect x="4" y="4" width="1.02" height="2.04"/><rect x="4" y="6" width="1.02" height="2.04"/><rect x="3" y="6" width="1.02" height="2.04"/><rect x="5" y="4" width="1.02" height="2.04"/><rect x="6" y="4" width="1.02" height="2.04"/><rect x="6" y="6" width="1.02" height="2.04"/><rect x="5" y="6" width="1.02" height="2.04"/><rect x="7" y="4" width="1.02" height="2.04"/><rect x="8" y="4" width="1.02" height="2.04"/><rect x="8" y="6" width="1.02" height="2.04"/><rect x="7" y="6" width="1.02" height="2.04"/><rect x="9" y="4" width="1.02" height="2.04"/><rect x="10" y="4" width="1.02" height="2.04"/><rect x="10" y="6" width="1.02" height="2.04"/><rect x="9" y="6" width="1.02" height="2.04"/><rect x="11" y="4" width="1.02" height="2.04"/><rect x="12" y="4" width="1.02" height="2.04"/><rect x="12" y="6" width="1.02" height="2.04"/><rect x="11" y="6" width="1.02" height="2.04"/><rect x="13" y="4" width="1.02" height="2.04"/><rect x="14" y="4" width="1.02" height="2.04"/><rect x="13" y="6" width="1.02" height="2.04"/><rect x="15" y="4" width="1.02" height="2.04"/><rect x="3" y="8" width="1.02" height="2.04"/><rect x="5" y="8" width="1.02" height="2.04"/><rect x="10" y="8" width="1.02" height="2.04"/><rect x="12" y="8" width="1.02" height="2.04"/></svg></span>`,
  codex: `<span class="tool-icon"><svg viewBox="-12 -12 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(0) translate(3.2 0)"/><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(60) translate(3.2 0)"/><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(120) translate(3.2 0)"/><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(180) translate(3.2 0)"/><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(240) translate(3.2 0)"/><rect x="-2.7" y="-9.9" width="5.4" height="11.5" rx="2.7" transform="rotate(300) translate(3.2 0)"/></svg></span>`,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout(ctx, { title, body, head = "", bodyClass = "" }) {
  const { user, lang, t } = ctx;
  const other = t("lang.other");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="theme-color" content="#5B4BFF">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=JetBrains+Mono:wght@500;700&family=Zen+Maru+Gothic:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<script>window.RW_T = ${JSON.stringify(clientStrings(lang)).replace(/</g, "\\u003c")};</script>
${head}
</head>
<body class="${bodyClass} lang-${lang}">
<header class="top">
  <a class="brand" href="${user ? "/me" : "/"}"><span class="name">ratelimit<span>.world</span></span><sub class="by">by bizencore</sub></a>
  <nav>
    <a href="/leaderboard">${t("nav.board")}</a>
    ${user ? `<a class="me" href="/@${esc(user.login)}">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : ""}@${esc(user.login)}</a>` : `<a class="btn small" href="/login">${t("nav.login")}</a>`}
  </nav>
</header>
<main>${body}</main>
<footer class="foot">
  <a class="brand-sm" href="/">ratelimit.world</a>
  <a class="lang" href="/lang/${other}?next=${encodeURIComponent(ctx.path || "/")}" hreflang="${other}" lang="${other}">🌐 ${t("lang.switch")}</a>
</footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

export function message(ctx, title, text, href, label) {
  return layout(ctx, {
    title: `${title} · ratelimit.world`,
    body: `<section class="card narrow center"><h1 class="h2">${esc(title)}</h1><p>${esc(text)}</p>${href ? `<p><a class="btn" href="${esc(href)}">${esc(label)}</a></p>` : ""}</section>`,
  });
}

export function devLogin(ctx, next) {
  const { t } = ctx;
  return layout(ctx, {
    title: t("dev.title"),
    body: `<section class="card narrow"><h1 class="h2">${t("dev.title")}</h1>
<p class="muted">${t("dev.text")}</p>
<form action="/dev/login" method="get" class="row"><input name="login" value="dev" aria-label="${t("dev.name")}"><input type="hidden" name="next" value="${esc(next)}"><button class="btn">${t("nav.login")}</button></form></section>`,
  });
}

// ---------- landing ----------
// 1日の枠を 24時間の帯で描く。starts は開始時刻 (時間)。
function dayBar(starts, cls) {
  const blocks = starts.map((h, i) => {
    const left = (h / 24) * 100;
    const width = Math.min(5, 24 - h) / 24 * 100;
    const label = `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
    return `<div class="blk ${h + 5 > 24 ? "spill" : ""}" style="left:${left}%;width:${width}%"><span>${i + 1}</span><em>${label}</em></div>`;
  }).join("");
  return `<div class="bar ${cls}">${blocks}</div>`;
}

export function landing(ctx, origin) {
  const { user, t } = ctx;
  const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${t("lp.hour", h)}</span>`).join("");
  return layout(ctx, {
    title: t("lp.title"),
    bodyClass: "landing",
    body: `
<section class="hero">
  <p class="eyebrow">${t("lp.eyebrow")}</p>
  <h1 class="display">${t("lp.hero")}</h1>
  <p class="lead">${t("lp.lead")}</p>

  <figure class="compare">
    <div class="lane">
      <p class="lane-name">${t("lp.good")}</p>
      ${dayBar([8, 13, 18, 23], "good")}
      <p class="lane-sum">${t("lane.sum", 4)}</p>
    </div>
    <div class="lane">
      <p class="lane-name">${t("lp.bad")}</p>
      ${dayBar([8, 13.5, 19], "bad")}
      <p class="lane-sum">${t("lane.sum", 3)}</p>
    </div>
    <div class="axis">${ticks}</div>
    <figcaption>${t("lp.caption")}</figcaption>
  </figure>

  <aside class="loss" aria-label="${t("lp.loss.aria")}">
    <p class="loss-lead">${t("lp.loss.lead")}</p>
    <p class="loss-num">${t("lp.loss.num")}</p>
    <p class="loss-sub">${t("lp.loss.sub")}</p>
    <p class="loss-note">${t("lp.loss.note")}</p>
  </aside>

  <div class="cta">
    ${user ? `<a class="btn big" href="/me">${t("lp.open")}</a>` : `<a class="btn big" href="/login">${t("lp.start")}</a>`}
    <a class="btn ghost" href="/leaderboard">${t("lp.board")}</a>
  </div>
</section>

<section class="how">
  <div class="how-item">
    <h2 class="h3">${t("lp.how1.h")}</h2>
    <p>${t("lp.how1.p")}</p>
    <pre class="cmd"><code>curl -fsSL ${esc(origin)}/install.sh | sh</code></pre>
  </div>
  <div class="how-item">
    <h2 class="h3">${t("lp.how2.h")}</h2>
    <p>${t("lp.how2.p")}</p>
  </div>
  <div class="how-item">
    <h2 class="h3">${t("lp.how3.h")}</h2>
    <p>${t("lp.how3.p")}</p>
  </div>
</section>`,
  });
}

// ---------- dashboard ----------
// キャラクター「リミ」: まるい体に小さな炎。表情 (目と口) だけを気分で変える
function limi(mood) {
  const eyes = {
    neutral: `<circle cx="25" cy="34" r="4"/><circle cx="39" cy="34" r="4"/>`,
    happy: `<path d="M21 35q4-5 8 0M35 35q4-5 8 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    cheer: `<path d="M21 35q4-5 8 0M35 35q4-5 8 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    excited: `<circle cx="25" cy="33" r="5"/><circle cx="39" cy="33" r="5"/><circle cx="26.5" cy="31.5" r="1.6" fill="#fff"/><circle cx="40.5" cy="31.5" r="1.6" fill="#fff"/>`,
    sad: `<path d="M21 33q4 3 8 1M35 34q4 2 8-1" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    worried: `<circle cx="25" cy="35" r="3.5"/><circle cx="39" cy="35" r="3.5"/><path d="M20 28l8 2M44 28l-8 2" fill="none" stroke-width="2.5" stroke-linecap="round"/>`,
  }[mood];
  const mouth = {
    neutral: `<path d="M27 43q5 4 10 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    happy: `<path d="M25 42q7 7 14 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    cheer: `<path d="M25 41q7 10 14 0z" stroke-width="2" stroke-linejoin="round"/>`,
    excited: `<ellipse cx="32" cy="44" rx="4" ry="5"/>`,
    sad: `<path d="M27 46q5-4 10 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
    worried: `<path d="M28 45q4-2 8 0" fill="none" stroke-width="3" stroke-linecap="round"/>`,
  }[mood];
  const extra = mood === "sad" ? `<path d="M44 38q2 4 0 6q-2-2 0-6z" fill="#7FD3F7" stroke="none"/>`
    : mood === "cheer" ? `<circle cx="8" cy="14" r="2.5" fill="#FF7A1A" stroke="none"/><circle cx="57" cy="10" r="2" fill="#16B364" stroke="none"/><circle cx="56" cy="24" r="2.5" fill="#36B9E8" stroke="none"/>`
    : "";
  return `<svg class="limi-svg" viewBox="0 0 64 64" aria-hidden="true">
    <path class="flame" d="M32 4c5 6 8 9 8 14a8 8 0 0 1-16 0c0-3 2-5 3-7 1 3 3 4 4 4-1-4 0-8 1-11z"/>
    <ellipse class="body" cx="32" cy="38" rx="24" ry="22"/>
    <ellipse class="cheek" cx="18" cy="42" rx="4" ry="2.5"/><ellipse class="cheek" cx="46" cy="42" rx="4" ry="2.5"/>
    <g class="face">${eyes}${mouth}</g>${extra}
  </svg>`;
}

function mascot(ctx, s, now) {
  const m = moodOf(s, now);
  const tool = m.tool ? TOOL_NAME[m.tool] : "";
  const text = ctx.t(`mood.${m.key}`, { n: m.n, m: m.m, left: m.left, tool });
  return `<section class="mascot mood-${m.mood}" aria-label="${esc(ctx.t("mood.aria"))}"><div class="limi">${limi(m.mood)}</div><p class="bubble">${esc(text)}</p></section>`;
}

// リーグ: ツールごとに 1枚。昇格ゾーン (上位) と降格ゾーン (下位) の境目に線を引く
function leagueLeft(ctx, ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return ctx.t("lg.left", Math.floor(m / 1440), Math.floor(m / 60) % 24, m % 60);
}

function leagueCards(ctx, data, s, now) {
  if (!data?.leagues.length) return "";
  const { user, t, lang } = ctx;
  const { week } = data;
  return data.leagues.map((L) => {
    const name = leagueName(lang, L.tier);
    const [tool, plan] = L.board.split(":");
    const lastName = L.last ? leagueName(lang, L.last.result === "up" ? L.last.tier + 1 : L.last.result === "down" ? L.last.tier - 1 : L.last.tier) : "";
    const last = L.last ? `<p class="lg-last ${L.last.result}">${t(L.last.result === "up" ? "lg.lastUp" : L.last.result === "down" ? "lg.lastDown" : "lg.lastStay", L.last.rank, esc(lastName))}</p>` : "";
    const n = L.members.length;
    const rows = L.members.map((m, i) => {
      const zone = i < L.zones.up && m.xp > 0 ? "up" : i >= n - L.zones.down ? "down" : "";
      const line = i === L.zones.up && L.zones.up > 0 ? `<li class="lg-line up" aria-hidden="true"><span>${t("lg.up")}</span></li>`
        : i === n - L.zones.down && L.zones.down > 0 ? `<li class="lg-line down" aria-hidden="true"><span>${t("lg.down")}</span></li>` : "";
      return `${line}<li class="${zone} ${m.user_id === user.id ? "you" : ""}">
        <span class="rank">${i + 1}</span>
        ${m.avatar_url ? `<img src="${esc(m.avatar_url)}" alt="">` : `<span class="noav"></span>`}
        <a href="/@${esc(m.login)}">@${esc(m.login)}</a>${m.user_id === user.id ? `<small class="fr-you">${t("lg.you")}</small>` : "<span></span>"}
        <b>${m.xp.toLocaleString()} XP</b>
      </li>`;
    }).join("");
    const body = !user.public ? `<p class="muted">${t("lg.private")}</p>`
      : !L.joined ? `<p class="muted">${t("lg.notYet", esc(name))}</p>`
      : `<ol class="board lg-list">${rows}</ol>`;
    return `<section class="card league tier-${L.tier}" id="league-${tool}">
  <div class="lg-head">
    <span class="lg-badge" aria-hidden="true">${TIER_EMOJI[L.tier]}</span>
    <div><h2 class="h3">${t("lg.h", esc(name))}</h2><p class="muted small">${esc(planName(ctx, tool, plan))}</p></div>
  </div>
  <p class="lg-ends">${t("lg.ends", esc(fmtWhen(lang, week.end, s.tz)), leagueLeft(ctx, week.end - now))}</p>
  ${last}
  ${body}
  <p class="muted small">${t("lg.rules")}</p>
</section>`;
  }).join("");
}

// フレンド: 自分とフォローしている人を今週の XP 順に並べる。各行に 🔥連続・今日の枠・今の状況
function friendStatus(ctx, s, now) {
  const waiting = (s.todayResets ?? []).filter((r) => r.passed && r.waiting && !r.rest).at(-1);
  if (waiting) return `<span class="fr-st go">${ctx.t("fr.waiting", Math.round((now - waiting.resetAt) / 60000))}</span>`;
  if (Object.values(s.tools).some((x) => x.state === "limited" && x.resetAt > now)) return `<span class="fr-st lim">${ctx.t("fr.limited")}</span>`;
  return "";
}

function friendsCard(ctx, s, friends, flash, origin, now) {
  const { user, t } = ctx;
  const rows = [{ u: user, s, me: true }, ...friends].sort((a, b) => b.s.weekXp - a.s.weekXp);
  const row = (r, i) => `<li class="${r.me ? "you" : ""}">
      <span class="rank">${i + 1}</span>
      ${r.u.avatar_url ? `<img src="${esc(r.u.avatar_url)}" alt="">` : `<span class="noav"></span>`}
      <div class="fr-main">
        <span class="fr-name"><a href="/@${esc(r.u.login)}">@${esc(r.u.login)}</a>${r.me ? ` <small class="fr-you">${t("fr.you")}</small>` : ""}</span>
        <span class="fr-sub"><span class="fr-flame">🔥${r.s.streak}</span> · ${t("fr.today", r.s.todayCount, r.s.goal)}${r.s.todayDone ? " ✓" : ""} ${friendStatus(ctx, r.s, now)}</span>
      </div>
      <b>${r.s.weekXp.toLocaleString()} XP</b>
    </li>`;
  const who = esc(flash?.who || "");
  const msg = {
    added: t("fr.added", who), removed: t("fr.removed", who), self: t("fr.self"), full: t("fr.full"),
    notfound: `${t("fr.notfound", who)} <button class="link" data-copy-text="${esc(origin)}">${t("fr.invite")}</button>`,
  }[flash?.kind];
  return `<section class="card friends" id="friends">
  <h2 class="h3">${t("fr.h")}</h2>
  ${msg ? `<p class="fr-flash ${flash.kind === "notfound" || flash.kind === "full" || flash.kind === "self" ? "bad" : ""}" role="status">${msg}</p>` : ""}
  <ol class="board fr-list">${rows.map(row).join("")}</ol>
  ${friends.length ? "" : `<p class="muted small">${t("fr.empty")}</p>`}
  <form class="follow-form" method="post" action="/follow">
    <input type="hidden" name="next" value="/me">
    <label class="sr-only" for="fr-login">${t("fr.label")}</label>
    <input id="fr-login" name="login" placeholder="${esc(t("fr.placeholder"))}" required maxlength="40" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="btn">${t("fr.follow")}</button>
  </form>
  <p class="muted small">${t("fr.note")}</p>
</section>`;
}

// デイリークエスト (今日の 3つ)
function questList(ctx, s) {
  return `<ul class="quests">${s.todayQuests.map((q) => `<li class="${q.done ? "done" : ""}">
      <span class="q-check" aria-hidden="true">${q.done ? "✓" : ""}</span>
      <span class="q-title">${esc(ctx.t(`q.${q.id}`, { n: q.target }))}</span>
      <span class="q-val">${q.value}/${q.target}</span>
      <span class="q-xp">+${q.xp}</span>
      <i class="q-mini" style="--p:${Math.round((q.value / q.target) * 100)}%"></i>
    </li>`).join("")}</ul>`;
}

// 直近7日のストリーク (Duolingo の丸の列): 達成🔥 / フリーズ🧊 / 週間リミット中🏆 / 未達 / 今日
function weekStrip(ctx, s) {
  const { t, lang } = ctx;
  const fmt = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { weekday: "narrow", timeZone: "UTC" });
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const k = addDays(s.today, -i);
    const count = s.days[k]?.count ?? 0;
    const met = count >= s.goal;
    const kind = met ? "met" : s.frozenDays.includes(k) ? "frozen" : s.lockedDays.includes(k) ? "locked" : i === 0 ? "pending" : "missed";
    days.push({ k, i, count, kind, keeps: kind === "met" || kind === "frozen" || kind === "locked" });
  }
  // ストリークの帯: 続けて達成している日 (フリーズ・週間リミットで守った日も含む) をひとつながりに囲む。
  // 今日がまだでも昨日まで続いていれば、今日も帯の端に入れる (今日やれば伸びる)
  const today = days[6];
  if (!today.keeps && days[5].keeps) today.joins = true;
  const inRun = (d) => d && (d.keeps || d.joins);
  for (let j = 0; j < 7; j++) {
    const d = days[j];
    if (!inRun(d)) continue;
    const prev = inRun(days[j - 1]), next = inRun(days[j + 1]);
    if (!prev && !next) continue; // 1日だけは帯にしない
    d.run = prev && next ? "run-mid" : prev ? "run-end" : "run-start";
  }
  // 今日 (または昨日から今日) につながっている帯だけが今のストリーク。それ以外の帯は過去のものとして落ち着いた色に
  const current = new Set();
  for (let j = 6; j >= 0 && inRun(days[j]); j--) current.add(j);
  days.forEach((d, j) => { if (d.run && !current.has(j)) d.run += " past"; });
  let out = "";
  for (const d of days) {
    // 丸の中はその日に使い切った枠の数。達成などは枠線の色で表す (光らせない)
    const icon = d.count > 0 ? String(d.count) : "";
    const [y, m, dd] = d.k.split("-").map(Number);
    const label = `${d.k}: ${t(`week.${d.kind}`)} (${t("windows", d.count)})`;
    out += `<li class="wd ${d.kind} ${d.i === 0 ? "today" : ""} ${d.run ?? ""}" title="${esc(label)}" aria-label="${esc(label)}"><span class="dot">${icon}</span><small>${fmt.format(new Date(Date.UTC(y, m - 1, dd)))}</small></li>`;
  }
  return `<ol class="week-strip" aria-label="${t("week.aria")}">${out}</ol>`;
}

// 「2時間前」「3日前」のような経過時間
function ago(ctx, ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return ctx.t("ago.min", m);
  const h = Math.round(m / 60);
  return h < 24 ? ctx.t("ago.hour", h) : ctx.t("ago.day", Math.floor(h / 24));
}

// 次に新しい枠を開けられる時刻。どれかのツールに今の枠がなければ「今すぐ」(null)。
// 全ツールが使用中かリミット中なら、いちばん早いリセット時刻
function nextOpenAt(s, now) {
  const ends = ["claude", "codex"].map((tool) => {
    const lim = s.tools[tool]?.resetAt;
    const use = s.nextReset?.[tool]?.resetAt;
    const end = Math.max(lim > now ? lim : 0, use > now ? use : 0);
    return end || null;
  });
  return ends.some((e) => e == null) ? null : Math.min(...ends);
}

function nextWindowText(ctx, s, now) {
  const at = nextOpenAt(s, now);
  return at ? ctx.t("today.nextAt", localTime(at, s.tz)) : ctx.t("today.nextNow");
}

// 今日のトラック: 使い切った枠を、目標に向けて 1マスずつ積む。先のマスにも XP を見せて、次を取りたくさせる
function todayTrack(ctx, s, now) {
  const { t } = ctx;
  const n = s.todayCount;
  // 目標までのマス + 次の1マスだけ見せる (届かない上限は見せない)
  const slots = Math.min(12, Math.max(s.goal, n) + 1);
  const at = nextOpenAt(s, now);
  const nextLabel = at ? t("slot.at", localTime(at, s.tz)) : t("slot.now");
  let out = "";
  for (let i = 1; i <= slots; i++) {
    const w = s.todayWindows[i - 1];
    const goalMark = i === s.goal ? ` goal" data-goal-label="${t("slot.goal")}` : "";
    if (w) {
      out += `<li class="slot done tool-${w.tool}${goalMark}" style="--i:${i}" data-n="${i}">
        <b>${i}</b><span class="tool">${w.tool === "claude" ? "Claude" : "Codex"}</span><span class="xp">+${w.xp}</span></li>`;
    } else if (i === n + 1) {
      out += nextSlot(ctx, s, now, i, goalMark, nextLabel);
    } else {
      out += `<li class="slot${goalMark}" style="--i:${i}"><b>${i}</b><span class="xp">+${comboXp(i)}</span></li>`;
    }
  }
  return `<ol class="track" aria-label="${t("today.track")}">${out}</ol>`;
}

// 次に使い切る枠: どちらのツールで達成するかはまだ分からないので、上下 2段に分けて
// それぞれの今の残量 (リセット直後が 100%、使い切ると 0%) を出す。使い切りやすい方 (残量が少ない方) を上、リミット中で使えない方は下
function nextSlot(ctx, s, now, i, goalMark, nextLabel) {
  const halves = ["claude", "codex"].map((tool) => {
    const lim = s.tools[tool]?.state === "limited" && s.tools[tool].resetAt > now ? s.tools[tool].resetAt : null;
    const cur = s.nextReset?.[tool];
    const pct = lim ? null : cur?.resetAt > now ? cur.pct ?? null : 0;
    return { tool, lim, pct, known: lim != null || pct != null };
  });
  // 並び: 使えるもの (使用率が高い順) → 使用率不明 → リミット中
  const rank = (h) => (h.lim ? -2 : h.pct == null ? -1 : h.pct);
  halves.sort((a, b) => rank(b) - rank(a));
  const half = (h) => `<div class="half tool-${h.tool} ${h.lim ? "locked" : ""}" style="--p:${h.pct == null ? 0 : 100 - h.pct}%">
      <span class="tool">${h.tool === "claude" ? "Claude" : "Codex"}</span>
      <b>${h.lim ? ctx.t("slot.at", localTime(h.lim, s.tz)) : h.pct == null ? "—" : `${100 - Math.round(h.pct)}%`}</b>
    </div>`;
  return `<li class="slot next split${goalMark}" style="--i:${i}" title="${esc(nextLabel)} · +${comboXp(i)} XP">${halves.map(half).join("")}</li>`;
}

// 「リセット後すぐ再開」タスク: 今日のリセットごとに、再開までの時間
function quickTask(ctx, s, now) {
  const { t } = ctx;
  const rows = s.todayResets.map((r) => {
    const cls = !r.passed ? "future" : r.rest ? "rest" : r.quick ? "ok" : r.waiting ? "wait" : "late";
    const what = !r.passed ? t("reset.future")
      : r.rest ? t("reset.rest")
      : r.ticket ? t("reset.ticket")
      : r.waiting ? t("reset.waiting", Math.round((now - r.resetAt) / 60000))
      : t("reset.after", r.delayMin);
    return `<li class="${cls}"><time>${localTime(r.resetAt, s.tz)}</time><span class="tool">${TOOL_NAME[r.tool]}</span><span class="what">${what}${cls === "ok" ? " ✓" : ""}</span></li>`;
  }).join("");
  return rows ? `<ul class="resets">${rows}</ul>` : `<p class="muted small">${t("reset.none")}</p>`;
}

function heatmap(ctx, s, days = 28) {
  const { t } = ctx;
  let cells = "";
  for (let i = days - 1; i >= 0; i--) {
    const k = addDays(s.today, -i);
    const d = s.days[k];
    const c = d?.count ?? 0;
    const frozen = s.frozenDays.includes(k);
    const locked = s.lockedDays.includes(k);
    const lvl = frozen ? "frozen" : locked ? "locked" : c === 0 ? "l0" : c < s.goal ? "l1" : c === s.goal ? "l2" : "l3";
    const label = `${k}: ${frozen ? t("heat.frozen") : locked ? t("heat.locked") : t("windows", c)}${d?.weekly ? ` · ${t("heat.trophy")}` : ""}`;
    cells += `<i class="cell ${lvl} ${i === 0 ? "today" : ""}" title="${esc(label)}" aria-label="${esc(label)}"></i>`;
  }
  return `<div class="heat" role="img" aria-label="${t("heat.aria", days)}">${cells}</div>`;
}

// ダイヤルの下の欄。両方のダイヤルで同じマス目 (2列×3行) にして、高さをそろえる:
//   枠の開始 | 次のリセット
//   昨日     | 週間枠の残量
//   最後に使い切った (横いっぱい)
// 値がないマスは「—」にして、マスの数は変えない
const shortWhen = (lang, ms, tz) => new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
  timeZone: tz, month: lang === "ja" ? "numeric" : "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(ms));

const shortDay = (lang, ms, tz) => new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { timeZone: tz, month: lang === "ja" ? "numeric" : "short", day: "numeric" }).format(new Date(ms));

function dialFoot(ctx, tool, s, now, limitedAt) {
  const { t, lang } = ctx;
  const cell = (label, value, cls = "") => `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  const dash = `<span class="none">—</span>`;
  // 今の 5時間枠。リミット中ならその正確な時刻、使用中なら PC から届いた予定 (中継オフの Claude Code は推定)
  const r = limitedAt ? { resetAt: limitedAt, exact: true } : s.nextReset?.[tool];
  const active = r?.resetAt > now;
  const est = active && !r.exact ? `<small>${t("dial.estimated")}</small>` : "";
  const w = s.nextReset?.[tool]?.week;
  const week = w?.resetAt > now ? `${100 - Math.round(w.pct)}%<small>${t("dial.weekReset", shortDay(lang, w.resetAt, s.tz))}</small>` : dash;
  const last = s.lastHitByTool[tool];
  const lastText = last
    ? `${ago(ctx, now - last)}<small>${last < now - 20 * 3600 * 1000 ? shortWhen(lang, last, s.tz) : localTime(last, s.tz)}</small>`
    : t("dial.never");
  return `<dl class="dial-foot">
    ${cell(t("dial.started"), active ? localTime(r.resetAt - WINDOW_MS, s.tz) + est : dash)}
    ${cell(t("dial.nextReset"), active ? localTime(r.resetAt, s.tz) + est : dash)}
    ${cell(t("dial.yesterday"), t("windows", s.yesterdayByTool[tool]))}
    ${cell(t("dial.week"), week)}
    ${cell(t("dial.lastHit"), lastText, "wide")}
  </dl>`;
}

// ツールごとの「次のリセット」ダイヤル
// 「時間」と「使用率」の競争。外側の細い線が枠の経過時間、内側の太い線が使用率。
// 使用率が時間より前にいれば (リード)、このペースでリセット前に使い切れる
export function race(pct, start, now) {
  const elapsed = Math.min(100, Math.max(0, ((now - start) / WINDOW_MS) * 100));
  const lead = Math.round(pct - elapsed);
  // このペースで使い続けた場合: 使い切る時刻、または リセット時点の使用率
  const at = pct > 0 ? start + ((now - start) * 100) / pct : null;
  const reset = start + WINDOW_MS;
  return { elapsed, lead, maxAt: at && at <= reset ? at : null, pctAtReset: at && at > reset ? Math.round((pct * WINDOW_MS) / Math.max(1, now - start)) : null };
}

function dial(ctx, tool, s, now) {
  const { t, lang } = ctx;
  const x = s.tools[tool];
  const last = s.lastReset[tool];
  const lock = s.weeklyLocks.find((w) => w.tool === tool);
  // リングの下の箱 (どの状態でも同じ大きさ)。ペースが分かるときだけ緑/赤、それ以外は落ち着いた色
  let state, resetAt = null, usedPct = null, box;
  if (lock) {
    state = "weekly";
    resetAt = lock.resetAt;
    box = { title: t("box.weekly"), detail: t("box.until", fmtWhen(lang, lock.resetAt, s.tz)) };
  } else if (x?.state === "limited") {
    state = "limited";
    resetAt = x.resetAt;
    usedPct = 100;
    box = { title: t("box.limited"), detail: t("box.resetAt", localTime(x.resetAt, s.tz)) };
  } else if (s.nextReset?.[tool]?.resetAt > now) {
    // 使用中 (中継オフの Claude Code はリセット時刻が推定で、使用率は不明)
    const r = s.nextReset[tool];
    state = "using";
    resetAt = r.resetAt;
    usedPct = r.pct ?? null;
    box = { title: t("box.using"), detail: t(r.exact ? "box.resetAt" : "box.resetAbout", localTime(r.resetAt, s.tz)) };
  } else if (last && last.resumed_at == null && now - last.reset_at < 3 * 3600 * 1000) {
    state = "ready";
    box = { title: t("dial.ready"), detail: t("box.resetDone", localTime(last.reset_at, s.tz)) };
  } else {
    state = "idle";
    box = { title: t("dial.idle"), detail: t("box.idle") };
  }
  const start = resetAt && state !== "weekly" ? resetAt - WINDOW_MS : null;
  const R = 52, C = 2 * Math.PI * R;
  const off = (f) => (C * (1 - Math.min(1, Math.max(0, f)))).toFixed(1);
  // 使用率が分かるとき: リング = 残量 (リセット直後が満タンで、使うほど減る)。間に合うペースかどうかは下の一文で伝える (緑 = 間に合う / オレンジ = 余る)。
  // 分からないとき: リング = リセットまでの残り時間
  const raceOn = start != null && usedPct != null;
  let frac = 0, elapsed = 0, ahead = true;
  if (raceOn) {
    const r = race(usedPct, start, now);
    elapsed = r.elapsed / 100;
    ahead = usedPct >= r.elapsed;
    frac = 1 - usedPct / 100;
    if (state === "using") box = r.maxAt
      ? { kind: "ok", title: t("c.paceOk"), detail: t("c.paceMaxAt", { t: localTime(r.maxAt, s.tz) }) }
      : { kind: "short", title: t("c.paceBad"), detail: t("c.paceShortAt", { p: 100 - Math.min(100, r.pctAtReset) }) };
  } else if (resetAt) frac = Math.min(1, Math.max(0, (resetAt - now) / WINDOW_MS));
  if (state === "weekly") frac = 1;
  return `
<article class="dial tool-${tool} ${state} ${raceOn ? (ahead ? "race ahead" : "race behind") : ""}" data-tool="${tool}" data-tz="${esc(s.tz)}"
  ${resetAt ? `data-reset="${resetAt}"` : ""} ${start ? `data-start="${start}"` : ""} ${usedPct != null ? `data-pct="${usedPct}"` : ""} ${state === "ready" ? `data-since="${last.reset_at}"` : ""}>
  <h3>${TOOL_ICON[tool]}${TOOL_NAME[tool]}</h3>
  <div class="ring" ${raceOn ? `role="img" aria-label="${esc(t("dial.raceAria", 100 - Math.round(usedPct), Math.round(elapsed * 100)))}"` : ""}>
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${R}"/>
      <circle class="fill" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off(frac)}" data-c="${C.toFixed(1)}"/>
    </svg>
    <div class="ring-text">
      ${raceOn
        ? `<small class="remain">${t("dial.remain")}</small><b class="pct">${100 - Math.round(usedPct)}%</b><small class="left">${t("dial.left")} <span class="clock"></span></small>`
        : `<small>${t(`dial.${state}`)}</small><b class="clock">${state === "ready" ? "GO" : state === "idle" ? "—" : ""}</b>`}
    </div>
  </div>
  <div class="pace ${box.kind ?? "neutral"}" ${box.kind ? "data-pace" : ""}><b>${esc(box.title)}</b><span>${esc(box.detail)}</span></div>
  ${dialFoot(ctx, tool, s, now, state === "limited" ? resetAt : null)}
</article>`;
}

export function dashboard(ctx, s, { origin, vapidKey, hasCli, notify, friends = [], flash = null, leagues = null }) {
  const { user, t, lang } = ctx;
  const now = Date.now();
  const left = Math.max(0, s.goal - s.todayCount);
  const chk = (k) => `<label class="toggle"><input type="checkbox" name="notify.${k}" ${notify[k] ? "checked" : ""}><span>${t(`notify.${k}`)}</span></label>`;
  const last = user.last_sync_at ? new Date(user.last_sync_at).toLocaleString(lang === "ja" ? "ja-JP" : "en-US", { timeZone: s.tz }) : null;
  const tier = tierName(lang, s.tier);
  const record = s.todayIsRecord && s.todayCount > 1;
  return layout(ctx, {
    title: t("dash.title"),
    head: `<meta name="rw-vapid" content="${esc(vapidKey)}">`,
    bodyClass: "dash",
    body: `
<section class="stats-row" aria-label="${t("dash.stats")}">
  <div class="stat flame"><b>${s.streak}</b><span>${t("stat.streak")}</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>${t("stat.weekXp")}</span></div>
  <div class="stat ice" title="${t("stat.freezes.tip")}"><b>${s.freezes}</b><span>${t("stat.freezes")}</span><small class="next">${s.freezeIn == null ? t("stat.freezes.max") : t("stat.freezes.in", s.freezeIn)}</small></div>
  ${s.trophies ? `<div class="stat trophy" title="${t("stat.trophies.tip")}"><b>${s.trophies}</b><span>${t("stat.trophies")}</span></div>` : ""}
</section>
${weekStrip(ctx, s)}
${mascot(ctx, s, now)}
${s.weeklyLocks.length ? `<section class="card lock"><p>🏆 <b>${t("lock.title")}</b> ${s.weeklyLocks.map((w) => t("lock.item", w.tool, fmtWhen(lang, w.resetAt, s.tz))).join(t("lock.sep"))}${t("lock.tail")}</p></section>` : ""}

<section class="card today" data-celebrate data-day="${s.today}" data-count="${s.todayCount}" data-tier="${esc(tier)}" data-last-xp="${s.todayWindows.at(-1)?.xp ?? 0}" data-record="${record ? 1 : ""}" data-goal-hit="${s.todayCount === s.goal ? 1 : ""}">
  <details class="tasks" open data-tasks>
  <summary class="today-head">
    <h1 class="h2">${t("tasks.h")}</h1>
    <span class="brief" aria-hidden="true">🎯 ${s.todayCount}/${s.goal} · ⚡ ${s.todayResetsPassed ? `${s.todayQuick}/${s.todayResetsPassed}` : "—"} · 🎁 ${s.todayQuests.filter((q) => q.done).length}/${s.todayQuests.length} · +${s.todayXp} XP</span>
    <p class="today-xp"><b>+${s.todayXp}</b> XP</p>
    <span class="chev" aria-hidden="true"></span>
  </summary>

  <div class="quest">
    <div class="quest-head"><span class="q-icon" aria-hidden="true">🎯</span><b>${t("quest.max")}</b>${tier ? `<span class="tier">${esc(tier)}</span>` : ""}<span class="q-prog">${s.todayCount} / ${s.goal}</span></div>
    <div class="q-bar"><i style="width:${Math.min(100, (s.todayCount / s.goal) * 100)}%"></i></div>
    ${todayTrack(ctx, s, now)}
    <p class="today-note">${s.todayDone
      ? t("today.done", s.goal, s.todayCount + 1, esc(tierName(lang, s.nextTier)), s.nextXp)
      : t("today.left", left) + nextWindowText(ctx, s, now)}${record ? ` · <span class="record">${t("today.record")}</span>` : s.bestDay > 0 ? ` · ${t("today.best", s.bestDay)}` : ""}</p>
  </div>

  <div class="quest">
    <div class="quest-head"><span class="q-icon" aria-hidden="true">⚡</span><b>${t("quest.quick")}</b><span class="q-prog">${s.todayResetsPassed ? `${s.todayQuick} / ${s.todayResetsPassed}` : "—"}</span></div>
    <div class="q-bar quick"><i style="width:${s.todayResetsPassed ? (s.todayQuick / s.todayResetsPassed) * 100 : 0}%"></i></div>
    ${quickTask(ctx, s, now)}
    <p class="late">${t("today.late", s.todayLateMin)}${s.quickRun > 0 ? ` · ${t("today.quick", s.quickRun)}` : ""}</p>
    <p class="warmup">💡 ${t("warmup.tip")} <span class="soon">${t("warmup.soon")}</span></p>
  </div>

  <div class="quest">
    <div class="quest-head"><span class="q-icon" aria-hidden="true">🎁</span><b>${t("quest.daily")}</b><span class="q-prog">${s.todayQuests.filter((q) => q.done).length} / ${s.todayQuests.length}</span></div>
    ${questList(ctx, s)}
  </div>
  </details>
</section>
<div class="toast" data-toast role="status" aria-live="polite" hidden></div>

<section class="dials">
  ${dial(ctx, "claude", s, now)}
  ${dial(ctx, "codex", s, now)}
</section>

${leagueCards(ctx, leagues, s, now)}

${friendsCard(ctx, s, friends, flash, origin, now)}

<section class="card">
  <h2 class="h3">${t("heat.h")}</h2>
  ${heatmap(ctx, s)}
  <p class="legend"><i class="cell l0"></i>0 <i class="cell l1"></i>${t("legend.under")} <i class="cell l2"></i>${t("legend.met")} <i class="cell l3"></i>${t("legend.over")} <i class="cell frozen"></i>${t("legend.frozen")} <i class="cell locked"></i>${t("legend.locked")}</p>
</section>

<section class="card" id="notify">
  <h2 class="h3">${t("push.h")}</h2>
  <p class="muted" data-push-hint>${t("push.ios")}</p>
  <div class="row">
    <button class="btn" data-push-enable>${t("push.enable")}</button>
    <button class="btn ghost" data-push-test hidden>${t("push.test")}</button>
  </div>
  <p class="status" data-push-status role="status"></p>
</section>

<section class="card ${hasCli ? "" : "attention"}" id="setup">
  <h2 class="h3">${t(hasCli ? "setup.h.linked" : "setup.h.new")}</h2>
  <p>${t(hasCli ? "setup.p.linked" : "setup.p.new")}</p>
  <pre class="cmd"><code>curl -fsSL ${esc(origin)}/install.sh | sh</code><button class="copy" data-copy aria-label="${t("copy.cmd")}">${t("copy")}</button></pre>
  ${planBadges(ctx, user) ? `<p class="plans">${t("setup.plans")} ${planBadges(ctx, user)}</p>` : ""}
  <p class="muted small">${t("setup.note", last)}</p>
</section>

<section class="card" id="settings">
  <h2 class="h3">${t("settings.h")}</h2>
  <form class="settings" data-settings>
    <label>${t("settings.goal")} <select name="goal">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((g) => `<option ${g === s.goal ? "selected" : ""}>${g}</option>`).join("")}</select> ${t("settings.goal.unit")}</label>
    <label>${t("settings.remind")} <input type="time" name="remindAt" value="${esc(user.remind_at)}"></label>
    <label>${t("settings.tz")} <input name="tz" value="${esc(user.tz)}" list="tzs"><datalist id="tzs" data-tz-list></datalist></label>
    <label>${t("settings.lang")} <select name="lang"><option value="ja" ${lang === "ja" ? "selected" : ""}>日本語</option><option value="en" ${lang === "en" ? "selected" : ""}>English</option></select></label>
    <fieldset><legend>${t("settings.notify")}</legend>
      ${chk("hit")}
      ${chk("soon")}
      <label class="lead">${t("settings.lead")} <select name="notifyLead">${[1, 3, 5, 10, 15].map((n) => `<option value="${n}" ${n === (user.notify_lead ?? 5) ? "selected" : ""}>${t("settings.leadUnit", n)}</option>`).join("")}</select></label>
      ${chk("reset")}
      ${chk("late")}
      ${chk("pinch")}
      ${chk("goal")}
      ${chk("league")}
    </fieldset>
    <label class="toggle"><input type="checkbox" name="statusline" ${user.claude_statusline ? "checked" : ""}><span>${t("settings.statusline")}<small class="hint">${t("settings.statusline.hint")}</small></span></label>
    <label class="toggle"><input type="checkbox" name="public" ${user.public ? "checked" : ""}><span>${t("settings.public")}</span></label>
    <div class="row"><button class="btn">${t("settings.save")}</button><span class="status" data-settings-status role="status"></span></div>
  </form>
</section>

<section class="row share">
  <a class="btn ghost" href="/@${esc(user.login)}">${t("dash.profile")}</a>
  <a class="btn ghost" href="/welcome">${t("dash.redo")}</a>
  <form method="post" action="/logout"><button class="btn ghost">${t("dash.logout")}</button></form>
</section>`,
  });
}

// ---------- onboarding ----------
export function welcome(ctx, { origin, vapidKey }) {
  const { user, t } = ctx;
  const cmd = `curl -fsSL ${origin}/install.sh | sh`;
  return layout(ctx, {
    title: t("wel.title"),
    head: `<meta name="rw-vapid" content="${esc(vapidKey)}">`,
    bodyClass: "welcome-page",
    body: `
<section class="welcome" data-welcome data-goal="${user.goal}">
  <ol class="steps" aria-label="${t("wel.steps")}"><li class="on">${t("wel.step1")}</li><li>${t("wel.step2")}</li><li>${t("wel.step3")}</li></ol>

  <div class="step" data-step="1">
    <p class="eyebrow">${esc(t("wel.hello", user.login))}</p>
    <h1 class="h1">${t("wel.link.h")}</h1>
    <p>${t("wel.link.p")}</p>
    <pre class="cmd"><code>${esc(cmd)}</code><button class="copy" data-copy aria-label="${t("copy.cmd")}">${t("copy")}</button></pre>
    <p class="waiting" data-link-wait><i class="dot"></i>${t("wel.wait")}</p>
    <div class="reveal" data-link-done hidden>
      <p class="reveal-title">${t("wel.done")}</p>
      <div class="reveal-stats">
        <div><b data-h="total">0</b><span>${t("wel.total")}</span></div>
        <div><b data-h="lostTime">—</b><span>${t("wel.lostTime")}</span></div>
        <div><b data-h="windowValue">—</b><span>${t("wel.windowValue")}</span></div>
      </div>
      <p class="reveal-msg" data-h="message"></p>
      <p class="reveal-note muted small" data-h="note" hidden></p>
      <button class="btn big" data-next="2">${t("wel.toGoal")}</button>
    </div>
    <p class="skip"><button class="link" data-next="2">${t("wel.later")}</button></p>
  </div>

  <div class="step" data-step="2" hidden>
    <h1 class="h1">${t("wel.goal.h")}</h1>
    <p data-suggest>${t("wel.goal.p")}</p>
    <div class="goals">
      ${[1, 2, 3, 4, 5, 6, 7, 8].map((g) => `<button class="goal-card" data-goal-pick="${g}" aria-pressed="false">
        <span class="goal-n">${g}<small>${t("unit")}</small></span><span class="goal-name">${t(`goal.${g}.name`)}</span><span class="goal-desc">${t(`goal.${g}.desc`)}</span></button>`).join("")}
    </div>
    <div class="goal-preview" data-goal-preview hidden aria-live="polite">
      <p class="gp-level" data-gp="level"></p>
      <div class="gp-stats">
        <div><b data-gp="hours"></b><span>${t("gp.hours")}</span></div>
        <div><b data-gp="xp"></b><span>${t("gp.xp")}</span></div>
        <div><b data-gp="week"></b><span>${t("gp.week")}</span></div>
      </div>
      <p class="gp-note" data-gp="note"></p>
      <button class="btn big" data-goal-confirm>${t("gp.confirm")}</button>
    </div>
    <p class="muted small">${t("wel.goal.note")}</p>
  </div>

  <div class="step" data-step="3" hidden>
    <button class="link back-link" data-back="2">${t("wel.back.goal")}</button>
    <h1 class="h1">${t("wel.push.h")}</h1>
    <p>${t("wel.push.p")}</p>
    <p class="muted" data-push-hint>${t("push.ios")}</p>
    <div class="row">
      <button class="btn big" data-push-enable>${t("push.enable")}</button>
      <button class="btn ghost" data-push-test hidden>${t("push.test")}</button>
    </div>
    <p class="status" data-push-status role="status"></p>
    <p><button class="btn ghost" data-finish>${t("wel.finish")}</button> <button class="link" data-finish>${t("wel.skipPush")}</button></p>
  </div>
</section>`,
  });
}

// ---------- profile / leaderboard ----------
// プロフィールの記録カード。日付は "2026-10-05" のような日のキー
const fmtDay = (lang, k, withYear = false) => new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
  timeZone: "UTC", month: lang === "ja" ? "numeric" : "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}),
}).format(new Date(`${k}T00:00:00Z`));

function hm(ctx, min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? ctx.t("p.hm", h, m) : ctx.t("p.m", m);
}

function profileRecords(ctx, s, ps, loss) {
  const { t, lang } = ctx;
  const tile = (value, label, sub = "", cls = "") => `<div class="ptile"><dd class="${cls}">${value}</dd><dt>${label}</dt>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const year = (k) => k.slice(0, 4) !== String(new Date().getUTCFullYear());
  const bests = [
    ps.bestDay && tile(t("windows", ps.bestDay.count), t("p.bestDay"), fmtDay(lang, ps.bestDay.day, year(ps.bestDay.day))),
    ps.bestOpened && tile(t("windows", ps.bestOpened.count), t("p.bestOpened"), fmtDay(lang, ps.bestOpened.day, year(ps.bestOpened.day))),
    ps.bestWeek && tile(`${ps.bestWeek.xp.toLocaleString()} XP`, t("p.bestWeek"), t("p.weekOf", fmtDay(lang, ps.bestWeek.week, year(ps.bestWeek.week)))),
    tile(t("p.times", ps.bestQuickRun), t("p.bestQuickRun"), t("p.bestQuickRun.sub")),
    s.trophies ? tile(t("p.times", s.trophies), t("stat.trophies"), t("stat.trophies.tip")) : "",
  ].filter(Boolean).join("");
  const life = [
    tile(s.xp.toLocaleString(), t("p.totalXp")),
    tile(String(s.total), t("p.total"), `Claude Code ${ps.byTool.claude} · Codex ${ps.byTool.codex}`),
    tile(t("p.days", ps.activeDays), t("p.activeDays"), t("p.goalDays", ps.goalDays)),
    loss.priced ? tile(`$${loss.valueUsd.toLocaleString()}`, t("p.value"), t("p.value.sub")) : "",
    ps.firstAt ? tile(fmtDay(lang, new Date(ps.firstAt).toISOString().slice(0, 10), true), t("p.since"), "", "sm") : "",
  ].filter(Boolean).join("");
  const restarts = ps.restarts ? [
    tile(`${ps.quickRate}%`, t("p.quickRate"), t("p.quickRate.sub", ps.quick, ps.restarts)),
    tile(hm(ctx, ps.medianLateMin), t("p.medianLate"), t("p.medianLate.sub")),
    tile(hm(ctx, ps.lostMin), t("p.lost"), t("p.lost.sub"), ps.lostMin >= 60 ? "sm" : ""),
  ].join("") : "";
  const max = Math.max(1, ...ps.hours);
  const bars = ps.hours.map((n, h) => `<i style="--h:${(n / max) * 100}%" class="${h === ps.topHour ? "top" : ""}" title="${t("p.hourTip", h, n)}"></i>`).join("");
  const wd = t("p.weekdays");
  return `<section class="card pcard"><h2 class="h3">${t("p.bests")}</h2><dl class="ptiles">${bests}</dl></section>
<section class="card pcard"><h2 class="h3">${t("p.life")}</h2><dl class="ptiles">${life}</dl></section>
${restarts ? `<section class="card pcard"><h2 class="h3">${t("p.restarts")}</h2><dl class="ptiles">${restarts}</dl></section>` : ""}
${ps.topHour != null ? `<section class="card pcard"><h2 class="h3">${t("p.when")}</h2>
  <p class="muted">${t("p.whenTop", ps.topHour, wd[ps.topWeekday])}</p>
  <div class="hours" role="img" aria-label="${esc(t("p.hoursAria"))}">${bars}</div>
  <div class="hours-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
</section>` : ""}`;
}

export function profile(ctx, u, s, origin, social = {}) {
  const { t, lang, user: viewer } = ctx;
  const self = viewer?.id === u.id;
  // フォローボタン: ログインしていなければログインへ、フォロー中なら押すと解除
  const followBtn = self ? "" : !viewer
    ? `<a class="btn" href="/login?next=${encodeURIComponent(`/@${u.login}`)}">${t("fr.follow")}</a>`
    : `<form method="post" action="/follow"><input type="hidden" name="login" value="${esc(u.login)}"><input type="hidden" name="next" value="/@${esc(u.login)}">
        <input type="hidden" name="action" value="${social.following ? "unfollow" : "follow"}">
        <button class="btn ${social.following ? "ghost following" : ""}">${social.following ? `<span class="on">${t("fr.following")}</span><span class="off">${t("fr.unfollow")}</span>` : t("fr.follow")}</button></form>`;
  const url = `${origin}/@${u.login}`;
  const tier = tierName(lang, s.tier);
  return layout(ctx, {
    title: `@${u.login} · ratelimit.world`,
    head: `<meta property="og:title" content="${esc(t("prof.ogTitle", u.login, s.streak))}"><meta property="og:description" content="${esc(t("prof.ogDesc", s.todayCount, s.goal, s.weekXp))}"><meta property="og:image" content="${esc(url)}/card.svg?lang=${lang}"><meta name="twitter:card" content="summary_large_image">`,
    body: `
<section class="profile-head">
  ${u.avatar_url ? `<img class="avatar" src="${esc(u.avatar_url)}" alt="">` : ""}
  <div class="ph-main"><h1 class="h2">@${esc(u.login)}</h1>${u.name && u.name !== u.login ? `<p class="muted">${esc(u.name)}</p>` : ""}<p class="plans">${planBadges(ctx, u)}</p>
    <p class="muted small">${[u.created_at ? t("p.joined", esc(new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "long" }).format(new Date(u.created_at)))) : "", t("fr.followers", social.followers ?? 0)].filter(Boolean).join(" · ")}</p>
    ${(social.leagues ?? []).length ? `<p class="lg-tags">${social.leagues.map((l) => `<span class="lg-tag">${TIER_EMOJI[l.tier]} ${esc(t("lg.h", leagueName(lang, l.tier)))} <small>${l.tool === "claude" ? "Claude" : "Codex"}</small></span>`).join("")}</p>` : ""}</div>
  ${followBtn}
</section>
${social.flash === "added" ? `<p class="fr-flash" role="status">${t("fr.added", esc(u.login))} <a href="/me#friends">${t("fr.seeAll")}</a></p>` : ""}
<section class="stats-row">
  <div class="stat flame"><b>${s.streak}</b><span>${t("stat.streak")}</span></div>
  <div class="stat"><b>${s.bestStreak}</b><span>${t("stat.best")}</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>${t("stat.weekXp")}</span></div>
  <div class="stat"><b>${s.total}</b><span>${t("stat.total")}</span></div>
  ${s.trophies ? `<div class="stat trophy"><b>${s.trophies}</b><span>${t("stat.trophies")}</span></div>` : ""}
</section>
${self && !u.public ? `<p class="private-note" role="status">🔒 ${t("p.private")} <a href="/me#settings">${t("p.private.link")}</a></p>` : ""}
<section class="card">
  <h2 class="h3">${t("prof.today", s.todayCount)}${tier ? ` <span class="tier">${esc(tier)}</span>` : ""}</h2>
  ${todayTrack(ctx, s, Date.now())}
  ${heatmap(ctx, s)}
</section>
${social.ps ? profileRecords(ctx, s, social.ps, social.loss) : ""}
${u.public ? `<section class="card share-card">
  <img src="/@${esc(u.login)}/card.svg?lang=${lang}" alt="${esc(t("prof.cardAlt", u.login))}" width="600" height="315">
  <div class="row">
    <a class="btn" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(t("prof.shareText", s.streak))}&url=${encodeURIComponent(url)}">${t("prof.shareX")}</a>
    <button class="btn ghost" data-copy-text="${esc(url)}">${t("prof.copyLink")}</button>
  </div>
</section>` : ""}`,
  });
}

export function leaderboard(ctx, boards, selected) {
  const { user: viewer, t } = ctx;
  const order = (k) => {
    const [tool, plan] = k.split(":");
    const ps = Object.keys(PLAN_NAMES[tool]);
    return (tool === "claude" ? 0 : 100) + (ps.includes(plan) ? ps.indexOf(plan) : 50);
  };
  const keys = Object.keys(boards).sort((a, b) => order(a) - order(b));
  // 見ている人自身のプランのボードを最初に開く
  const mine = viewer ? keys.find((k) => k === `claude:${viewer.claude_plan}` || k === `codex:${viewer.codex_plan}`) : null;
  const cur = keys.includes(selected) ? selected : mine ?? keys[0];
  const name = (k) => { const [tool, p] = k.split(":"); return planName(ctx, tool, p); };
  const rows = boards[cur] ?? [];
  const tabs = keys.map((k) => `<a class="tab ${k === cur ? "on" : ""}" href="/leaderboard?board=${encodeURIComponent(k)}" ${k === cur ? 'aria-current="page"' : ""}>${esc(name(k))} <small>${boards[k].length}</small></a>`).join("");
  const list = rows.length
    ? rows.map((r, i) => `<li class="${viewer?.id === r.id ? "you" : ""}"><span class="rank">${i + 1}</span>${r.avatar_url ? `<img src="${esc(r.avatar_url)}" alt="">` : `<span class="noav"></span>`}<a href="/@${esc(r.login)}">@${esc(r.login)}</a><span class="fl">${t("windows", r.weekWindows)}</span><b>${r.weekXp.toLocaleString()} XP</b></li>`).join("")
    : `<li class="empty">${t("board.empty")}</li>`;
  return layout(ctx, {
    title: t("board.title"),
    body: `<section class="card"><h1 class="h2">${t("board.h")}</h1>
<p class="muted">${t("board.p")}</p>
${keys.length ? `<nav class="tabs" aria-label="${t("board.plans")}">${tabs}</nav>` : ""}
<ol class="board">${list}</ol></section>`,
  });
}

export function cliVerify(ctx, code) {
  const { user, t } = ctx;
  return layout(ctx, {
    title: t("verify.title"),
    body: `<section class="card narrow center">
<h1 class="h2">${t("verify.h")}</h1>
<p>${t("verify.p")}</p>
<form method="post" action="/cli/verify">
  <input class="code" name="code" value="${esc(code)}" aria-label="${t("verify.code")}" autocomplete="off">
  <p><button class="btn big">${esc(t("verify.btn", user.login))}</button></p>
</form>
<p class="muted small">${t("verify.note")}</p>
</section>`,
  });
}

// ---------- share card (SVG 1200x630) ----------
export function card(ctx, u, s) {
  const { t } = ctx;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const k = addDays(s.today, -i);
    const c = s.days[k]?.count ?? 0;
    const fill = s.frozenDays.includes(k) ? "#7FD8F5" : s.lockedDays.includes(k) ? "#E8B931" : c === 0 ? "#2E2A5C" : c < s.goal ? "#8F84FF" : "#FF7A1A";
    days.push(`<rect x="${80 + (13 - i) * 74}" y="470" width="62" height="62" rx="14" fill="${fill}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#17153A"/>
<circle cx="1080" cy="120" r="260" fill="#5B4BFF" opacity=".35"/>
<text x="80" y="110" fill="#B9B3FF" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700">ratelimit.world</text>
<text x="80" y="170" fill="#FFFFFF" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="700">@${esc(u.login)}</text>
<text x="72" y="380" fill="#FF7A1A" font-family="Helvetica, Arial, sans-serif" font-size="210" font-weight="900">${s.streak}</text>
<text x="${90 + String(s.streak).length * 118}" y="380" fill="#FFFFFF" font-family="Hiragino Sans, Noto Sans JP, Helvetica, sans-serif" font-size="64" font-weight="800">${esc(t("card.streak"))}</text>
<text x="80" y="440" fill="#B9B3FF" font-family="Hiragino Sans, Noto Sans JP, Helvetica, sans-serif" font-size="30">${esc(t("card.sub", s.weekXp.toLocaleString(), s.bestStreak))}</text>
${days.join("")}
</svg>`;
}

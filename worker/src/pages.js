// サーバーで組み立てる HTML。見た目は public/style.css、動きは public/app.js、文言は i18n.js。
// 各ページは ctx = { user, lang, t, path } を受け取る (t は翻訳関数)
import { TOOL_NAME, addDays, localTime, comboXp, WINDOW_MS } from "./logic.js";
import { clientStrings, tierName, fmtWhen } from "./i18n.js";

// 課金プランの表示名。CLI が送ってくる値 → 人が読める名前 (固有名詞なので言語で変えない)
const PLAN_NAMES = {
  claude: { pro: "Claude Pro", max: "Claude Max", max_5x: "Claude Max 5x", max_20x: "Claude Max 20x", team: "Claude Team", enterprise: "Claude Enterprise", unknown: null },
  codex: { free: "ChatGPT Free", plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Business", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu", unknown: null },
};
export const planName = (ctx, tool, plan) =>
  PLAN_NAMES[tool][plan || "unknown"] ?? (plan && plan !== "unknown" ? `${tool === "claude" ? "Claude" : "ChatGPT"} ${plan}` : ctx.t(`plan.unknown.${tool}`));
const planBadges = (ctx, u) => [["claude", u.claude_plan], ["codex", u.codex_plan]].filter(([, p]) => p).map(([tool, p]) => `<span class="plan">${esc(planName(ctx, tool, p))}</span>`).join("");

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
  <a class="brand" href="/">ratelimit<span>.world</span></a>
  <nav>
    <a href="/leaderboard">${t("nav.board")}</a>
    ${user ? `<a class="me" href="/me">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : ""}@${esc(user.login)}</a>` : `<a class="btn small" href="/login">${t("nav.login")}</a>`}
  </nav>
</header>
<main>${body}</main>
<footer class="foot">
  <span class="brand-sm">ratelimit.world</span>
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
const nextLimited = (s) => Object.values(s.tools).map((x) => x.resetAt).sort((a, b) => a - b)[0];

function nextWindowText(ctx, s, now) {
  const limited = nextLimited(s);
  return limited && limited > now ? ctx.t("today.nextAt", localTime(limited, s.tz)) : ctx.t("today.nextNow");
}

// 今日のトラック: 枠を 1つずつ積んでいく。先のマスにも XP を見せて、次を取りたくさせる
function todayTrack(ctx, s, now) {
  const { t } = ctx;
  const n = s.todayCount;
  // 目標までのマス + 次の1マスだけ見せる (届かない上限は見せない)
  const slots = Math.min(12, Math.max(s.goal, n) + 1);
  const limited = nextLimited(s);
  const ready = Object.values(s.lastReset).some((w) => w.resumed_at == null && now - w.reset_at < 3 * 3600 * 1000);
  const nextLabel = !ready && limited ? t("slot.at", localTime(limited, s.tz)) : t("slot.now");
  let out = "";
  for (let i = 1; i <= slots; i++) {
    const w = s.todayWindows[i - 1];
    const goalMark = i === s.goal ? ` goal" data-goal-label="${t("slot.goal")}` : "";
    if (w) {
      out += `<li class="slot done${goalMark}" style="--i:${i}" data-n="${i}">
        <b>${i}</b><span class="tool">${w.tool === "claude" ? "Claude" : "Codex"}</span><span class="xp">+${w.xp}</span></li>`;
    } else if (i === n + 1) {
      out += `<li class="slot next${goalMark}" style="--i:${i}"><b>${i}</b><span class="tool">${nextLabel}</span><span class="xp">+${comboXp(i)}</span></li>`;
    } else {
      out += `<li class="slot${goalMark}" style="--i:${i}"><b>${i}</b><span class="xp">+${comboXp(i)}</span></li>`;
    }
  }
  return `<ol class="track" aria-label="${t("today.track")}">${out}</ol>`;
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

// ツールごとの「次のリセット」ダイヤル
function dial(ctx, tool, s, now) {
  const { t, lang } = ctx;
  const x = s.tools[tool];
  const last = s.lastReset[tool];
  const lock = s.weeklyLocks.find((w) => w.tool === tool);
  let state, resetAt = null, frac = 0, sub;
  if (lock) {
    state = "weekly";
    resetAt = lock.resetAt;
    frac = 1;
    sub = t("dial.sub.weekly", fmtWhen(lang, lock.resetAt, s.tz));
  } else if (x?.state === "limited") {
    state = "limited";
    resetAt = x.resetAt;
    frac = Math.min(1, Math.max(0, (x.resetAt - now) / WINDOW_MS));
    sub = t("dial.sub.limited", localTime(x.resetAt, s.tz));
  } else if (last && last.resumed_at == null && now - last.reset_at < 3 * 3600 * 1000) {
    state = "ready";
    sub = t("dial.sub.ready", localTime(last.reset_at, s.tz));
  } else {
    state = "idle";
    sub = t("dial.sub.idle");
  }
  const R = 52, C = 2 * Math.PI * R;
  return `
<article class="dial ${state}" data-tool="${tool}" ${resetAt ? `data-reset="${resetAt}"` : ""} ${state === "ready" ? `data-since="${last.reset_at}"` : ""}>
  <h3>${TOOL_NAME[tool]}</h3>
  <div class="ring">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${R}"/>
      <circle class="fill" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}" data-c="${C.toFixed(1)}"/>
    </svg>
    <div class="ring-text"><small data-ready-label="${t("dial.ready")}">${t(`dial.${state}`)}</small><b class="clock">${state === "ready" ? "GO" : state === "idle" ? "—" : ""}</b></div>
  </div>
  <p class="dial-sub">${esc(sub)}</p>
</article>`;
}

export function dashboard(ctx, s, { origin, vapidKey, hasCli, notify }) {
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
  <div class="stat ice" title="${t("stat.freezes.tip")}"><b>${s.freezes}</b><span>${t("stat.freezes")}</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>${t("stat.weekXp")}</span></div>
  ${s.trophies ? `<div class="stat trophy" title="${t("stat.trophies.tip")}"><b>${s.trophies}</b><span>${t("stat.trophies")}</span></div>` : ""}
</section>
${s.weeklyLocks.length ? `<section class="card lock"><p>🏆 <b>${t("lock.title")}</b> ${s.weeklyLocks.map((w) => t("lock.item", w.tool, fmtWhen(lang, w.resetAt, s.tz))).join(t("lock.sep"))}${t("lock.tail")}</p></section>` : ""}

<section class="card today" data-celebrate data-day="${s.today}" data-count="${s.todayCount}" data-tier="${esc(tier)}" data-last-xp="${s.todayWindows.at(-1)?.xp ?? 0}" data-record="${record ? 1 : ""}" data-goal-hit="${s.todayCount === s.goal ? 1 : ""}">
  <div class="today-head">
    <h1 class="h2">${t("today.h")} <span class="num">${s.todayCount}</span><span class="unit">${t("unit")}</span>${tier ? `<span class="tier">${esc(tier)}</span>` : ""}</h1>
    <p class="today-xp"><b>+${s.todayXp}</b> XP</p>
  </div>
  ${todayTrack(ctx, s, now)}
  <p class="today-note">${s.todayDone
    ? t("today.done", s.goal, s.todayCount + 1, esc(tierName(lang, s.nextTier)), s.nextXp)
    : t("today.left", left) + nextWindowText(ctx, s, now)}${record ? ` · <span class="record">${t("today.record")}</span>` : s.bestDay > 0 ? ` · ${t("today.best", s.bestDay)}` : ""}</p>
  <p class="late">${t("today.late", s.todayLateMin)}${s.quickRun > 0 ? ` · ${t("today.quick", s.quickRun)}` : ""}</p>
</section>
<div class="toast" data-toast role="status" aria-live="polite" hidden></div>

<section class="dials">
  ${dial(ctx, "claude", s, now)}
  ${dial(ctx, "codex", s, now)}
</section>

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

<section class="card">
  <h2 class="h3">${t("settings.h")}</h2>
  <form class="settings" data-settings>
    <label>${t("settings.goal")} <select name="goal">${[1, 2, 3, 4, 5].map((g) => `<option ${g === s.goal ? "selected" : ""}>${g}</option>`).join("")}</select> ${t("settings.goal.unit")}</label>
    <label>${t("settings.remind")} <input type="time" name="remindAt" value="${esc(user.remind_at)}"></label>
    <label>${t("settings.tz")} <input name="tz" value="${esc(user.tz)}" list="tzs"><datalist id="tzs" data-tz-list></datalist></label>
    <label>${t("settings.lang")} <select name="lang"><option value="ja" ${lang === "ja" ? "selected" : ""}>日本語</option><option value="en" ${lang === "en" ? "selected" : ""}>English</option></select></label>
    <fieldset><legend>${t("settings.notify")}</legend>
      ${chk("hit")}
      ${chk("reset")}
      ${chk("late")}
      ${chk("pinch")}
      ${chk("goal")}
    </fieldset>
    <label class="toggle"><input type="checkbox" name="public" ${user.public ? "checked" : ""}><span>${t("settings.public")}</span></label>
    <div class="row"><button class="btn">${t("settings.save")}</button><span class="status" data-settings-status role="status"></span></div>
  </form>
</section>

<section class="row share">
  <a class="btn ghost" href="/@${esc(user.login)}">${t("dash.profile")}</a>
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
        <div><b data-h="avgLateMin">—</b><span>${t("wel.avgLate")}</span></div>
        <div><b data-h="bestDay">0</b><span>${t("wel.bestDay")}</span></div>
      </div>
      <p class="reveal-msg" data-h="message"></p>
      <button class="btn big" data-next="2">${t("wel.toGoal")}</button>
    </div>
    <p class="skip"><button class="link" data-next="2">${t("wel.later")}</button></p>
  </div>

  <div class="step" data-step="2" hidden>
    <h1 class="h1">${t("wel.goal.h")}</h1>
    <p data-suggest>${t("wel.goal.p")}</p>
    <div class="goals">
      ${[1, 2, 3, 4].map((g) => `<button class="goal-card" data-goal-pick="${g}">
        <span class="goal-n">${g}<small>${t("unit")}</small></span><span class="goal-name">${t(`goal.${g}.name`)}</span><span class="goal-desc">${t(`goal.${g}.desc`)}</span></button>`).join("")}
    </div>
    <p class="muted small">${t("wel.goal.note")}</p>
  </div>

  <div class="step" data-step="3" hidden>
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
export function profile(ctx, u, s, origin) {
  const { t, lang } = ctx;
  const url = `${origin}/@${u.login}`;
  const tier = tierName(lang, s.tier);
  return layout(ctx, {
    title: `@${u.login} · ratelimit.world`,
    head: `<meta property="og:title" content="${esc(t("prof.ogTitle", u.login, s.streak))}"><meta property="og:description" content="${esc(t("prof.ogDesc", s.todayCount, s.goal, s.weekXp))}"><meta property="og:image" content="${esc(url)}/card.svg?lang=${lang}"><meta name="twitter:card" content="summary_large_image">`,
    body: `
<section class="profile-head">
  ${u.avatar_url ? `<img class="avatar" src="${esc(u.avatar_url)}" alt="">` : ""}
  <div><h1 class="h2">@${esc(u.login)}</h1>${u.name && u.name !== u.login ? `<p class="muted">${esc(u.name)}</p>` : ""}<p class="plans">${planBadges(ctx, u)}</p></div>
</section>
<section class="stats-row">
  <div class="stat flame"><b>${s.streak}</b><span>${t("stat.streak")}</span></div>
  <div class="stat"><b>${s.bestStreak}</b><span>${t("stat.best")}</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>${t("stat.weekXp")}</span></div>
  <div class="stat"><b>${s.total}</b><span>${t("stat.total")}</span></div>
  ${s.trophies ? `<div class="stat trophy"><b>${s.trophies}</b><span>${t("stat.trophies")}</span></div>` : ""}
</section>
<section class="card">
  <h2 class="h3">${t("prof.today", s.todayCount)}${tier ? ` <span class="tier">${esc(tier)}</span>` : ""}</h2>
  ${todayTrack(ctx, s, Date.now())}
  ${heatmap(ctx, s)}
</section>
<section class="card share-card">
  <img src="/@${esc(u.login)}/card.svg?lang=${lang}" alt="${esc(t("prof.cardAlt", u.login))}" width="600" height="315">
  <div class="row">
    <a class="btn" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(t("prof.shareText", s.streak))}&url=${encodeURIComponent(url)}">${t("prof.shareX")}</a>
    <button class="btn ghost" data-copy-text="${esc(url)}">${t("prof.copyLink")}</button>
  </div>
</section>`,
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

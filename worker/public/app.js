// ダッシュボードの動き: リセットまでのカウントダウン、通知の登録、設定の保存、コピー
// 文言はサーバーが埋め込む window.RW_T (i18n.js の "c." で始まるもの) から引く
const T = (k, v = {}) => String((window.RW_T || {})[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? "");

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const WINDOW_MS = 5 * 3600 * 1000;

  // ---------- countdown ----------
  const pad = (n) => String(n).padStart(2, "0");
  function tick() {
    const now = Date.now();
    for (const d of $$(".dial[data-reset]")) {
      const reset = +d.dataset.reset;
      const left = reset - now;
      const clock = $(".clock", d);
      if (left <= 0) {
        // リセットの瞬間: GO に切り替える
        d.classList.remove("limited", "weekly", "using");
        d.classList.add("ready");
        delete d.dataset.reset;
        $(".ring-text small", d).textContent = T("c.ready");
        clock.textContent = "GO";
        continue;
      }
      const h = Math.floor(left / 3600000), m = Math.floor(left / 60000) % 60, s = Math.floor(left / 1000) % 60;
      // 週間リミットのように 1日以上先なら「3日 13時間」で見せる
      clock.textContent = h >= 24 ? T("c.days", { d: Math.floor(h / 24), h: h % 24 }) : `${h}:${pad(m)}:${pad(s)}`;
      if (d.classList.contains("limited") || d.classList.contains("using")) {
        const fill = $(".fill", d);
        fill.style.strokeDashoffset = (+fill.dataset.c * (1 - Math.min(1, left / WINDOW_MS))).toFixed(1);
      }
    }
    for (const d of $$(".dial.ready[data-since]")) {
      const min = Math.floor((now - +d.dataset.since) / 60000);
      $(".ring-text small", d).textContent = min > 0 ? T("c.lateNow", { n: min }) : T("c.ready");
    }
  }
  if ($(".dial")) { tick(); setInterval(tick, 1000); }

  // 開きっぱなしでも新しい記録が出るよう、見えているときだけ数分おきに読み直す
  if (document.body.classList.contains("dash")) {
    let last = Date.now();
    const refresh = () => { if (document.visibilityState === "visible" && Date.now() - last > 3 * 60 * 1000 && !document.activeElement?.closest("form")) location.reload(); };
    setInterval(refresh, 30 * 1000);
    document.addEventListener("visibilitychange", refresh);
  }

  // ---------- copy ----------
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = T("c.copied"); setTimeout(() => (btn.textContent = t), 1500); } catch {}
  }
  for (const b of $$("[data-copy]")) b.addEventListener("click", () => copy($("code", b.parentElement).textContent, b));
  for (const b of $$("[data-copy-text]")) b.addEventListener("click", () => copy(b.dataset.copyText, b));

  // ---------- settings ----------
  const form = $("[data-settings]");
  if (form) {
    const list = $("[data-tz-list]");
    try { list.innerHTML = Intl.supportedValuesOf("timeZone").map((z) => `<option value="${z}">`).join(""); } catch {}
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const notify = {};
      for (const el of $$("input[name^='notify.']", form)) notify[el.name.slice(7)] = el.checked;
      const status = $("[data-settings-status]");
      const res = await fetch("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: f.get("goal"), remindAt: f.get("remindAt"), tz: f.get("tz"), lang: f.get("lang"), notify, public: $("input[name=public]", form).checked, statusline: $("input[name=statusline]", form).checked }),
      });
      status.textContent = res.ok ? T("c.saved") : T("c.saveFailed");
      if (res.ok) setTimeout(() => location.reload(), 600);
    });
  }

  // ---------- push ----------
  const enableBtn = $("[data-push-enable]");
  if (enableBtn) {
    const status = $("[data-push-status]");
    const testBtn = $("[data-push-test]");
    const vapid = document.querySelector("meta[name=rw-vapid]")?.content;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone || !/iPhone|iPad/.test(navigator.userAgent)) $("[data-push-hint]").hidden = true;

    const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
    const setOn = (on) => {
      enableBtn.textContent = on ? T("c.pushOff") : T("c.pushOn");
      enableBtn.dataset.on = on ? "1" : "";
      testBtn.hidden = !on;
    };

    (async () => {
      if (!supported) { enableBtn.disabled = true; status.textContent = T("c.pushUnsupported"); return; }
      if (!vapid) { enableBtn.disabled = true; status.textContent = T("c.pushNoKey"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      setOn(!!sub && Notification.permission === "granted");
    })();

    enableBtn.addEventListener("click", async () => {
      const reg = await navigator.serviceWorker.ready;
      if (enableBtn.dataset.on) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
          await sub.unsubscribe();
        }
        setOn(false);
        status.textContent = T("c.pushStopped");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { status.textContent = T("c.pushDenied"); return; }
      try {
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapid) });
        const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
        if (!res.ok) throw new Error(String(res.status));
        setOn(true);
        status.textContent = T("c.pushReady");
      } catch (e) {
        status.textContent = T("c.pushFailed", { e: e.message });
      }
    });

    testBtn.addEventListener("click", async () => {
      const res = await fetch("/api/push/test", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
      status.textContent = res.ok ? T("c.testSent") : T("c.testFailed");
    });
  }
})();

// ---------- お祝い演出と、オンボーディング ----------
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // 紙吹雪 (動きを減らす設定のときは出さない)
  function burst(x = innerWidth / 2, y = innerHeight / 3, n = 36) {
    if (calm) return;
    const colors = ["#5B4BFF", "#FF7A1A", "#36B9E8", "#16B364", "#FFC53D"];
    for (let i = 0; i < n; i++) {
      const p = document.createElement("i");
      p.className = "confetti";
      const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 220;
      p.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--dx:${Math.cos(a) * v}px;--dy:${Math.sin(a) * v - 160}px;--r:${Math.random() * 720 - 360}deg`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1300);
    }
  }

  function toast(html, ms = 3600) {
    const t = $("[data-toast]") || Object.assign(document.body.appendChild(document.createElement("div")), { className: "toast" });
    t.innerHTML = html;
    t.hidden = false;
    t.classList.remove("show");
    void t.offsetWidth;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.classList.remove("show"); t.hidden = true; }, ms);
  }

  // ダッシュボード: 前に見たときより枠が増えていたら、増えた分を順にポップさせて祝う
  const today = $("[data-celebrate]");
  if (today) {
    const { day, count, tier, lastXp, record, goalHit } = today.dataset;
    const seen = store.get("rw:seen");
    const n = +count;
    if (seen && seen.day === day && n > seen.count) {
      const fresh = $$(".slot.done", today).filter((el) => +el.dataset.n > seen.count);
      fresh.forEach((el, i) => { el.classList.add("pop"); el.style.animationDelay = `${i * 180}ms`; });
      setTimeout(() => {
        const r = $(".slot.done.pop:last-of-type", today)?.getBoundingClientRect() ?? today.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, goalHit || record ? 60 : 30);
        toast(T("c.toast", { n, tier, xp: lastXp }) + (goalHit ? `<br>${T("c.toastGoal")}` : "") + (record ? `<br>${T("c.toastRecord")}` : ""));
      }, fresh.length * 180 + 250);
    }
    store.set("rw:seen", { day, count: n });
  }

  // ---------- /welcome ----------
  const root = $("[data-welcome]");
  if (!root) return;
  let step = 1;
  let goal = +root.dataset.goal || null;   // いま選んでいる目標 (戻ってきたときに選択済みで見せる)
  // ステップを切り替える。ブラウザの「戻る」でも前のステップに戻れるよう履歴に積む
  const show = (k, { push = true } = {}) => {
    step = k;
    for (const el of $$(".step", root)) el.hidden = +el.dataset.step !== k;
    $$(".steps li", root).forEach((li, i) => {
      li.classList.toggle("on", i < k);
      // 通った目標のステップは押して戻れる (PC 連携のステップには戻さない)
      li.classList.toggle("back", i === 1 && k > 2);
    });
    if (k === 1 && !history) poll();
    if (k === 2) suggest();
    if (push) window.history.pushState({ step: k }, "", k === 1 ? location.pathname : `#step${k}`);
    $(`.step[data-step="${k}"] h1`, root)?.scrollIntoView?.({ block: "nearest" });
  };
  addEventListener("popstate", (e) => show(e.state?.step || 1, { push: false }));
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

  // 1) PC の連携を待つ。届いたら過去の記録を見せる
  let history = null;
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    while (step === 1) {
      const me = await fetch("/api/me").then((r) => r.json()).catch(() => null);
      if (me?.linked && me.lastSyncAt) { reveal(me.history); break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    polling = false;
  }
  function countUp(el, to) {
    if (to == null) { el.textContent = "—"; return; }
    if (calm) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 900;
    const f = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  // 金額: 日本語は円 (1ドル=150円の目安)、英語はドル
  const ja = document.documentElement.lang === "ja";
  const money = (usd) => (ja ? `${(Math.round((usd * 150) / 100) * 100).toLocaleString("ja-JP")}円` : `$${Math.round(usd).toLocaleString("en-US")}`);
  const duration = (min) => (min >= 60 ? T("c.hm", { h: Math.floor(min / 60), m: min % 60 }) : T("c.m", { m: min }));

  function reveal(h) {
    history = h;
    const loss = h.loss || {};
    $("[data-link-wait]", root).hidden = true;
    $(".skip", root).hidden = true;
    $("[data-link-done]", root).hidden = false;
    countUp($('[data-h="total"]', root), h.total);
    $('[data-h="lostTime"]', root).textContent = loss.lostMin ? duration(loss.lostMin) : "—";
    // ツールごとに「Claude Code 7,200円」のように並べる
    const perWindow = [["Claude Code", loss.avgWindowUsd?.claude], ["Codex", loss.avgWindowUsd?.codex]].filter(([, v]) => v != null);
    $('[data-h="windowValue"]', root).innerHTML = perWindow.length
      ? perWindow.map(([name, v]) => `<span class="tv"><i>${name}</i>${money(v)}</span>`).join("")
      : "—";
    const msg = $('[data-h="message"]', root);
    if (h.total === 0) msg.textContent = T("c.revealEmpty");
    else if (!loss.lostMin) msg.textContent = T("c.revealGood");
    else msg.textContent = loss.priced && loss.year.usd > 0
      ? T("c.yearLoss", { hours: loss.year.hours.toLocaleString(), money: money(loss.year.usd) })
      : T("c.yearLossNoPrice", { hours: loss.year.hours.toLocaleString() });
    if (loss.priced) {
      const note = $('[data-h="note"]', root);
      note.textContent = T(loss.estimated ? "c.priceNoteEst" : "c.priceNote", { asOf: loss.pricingAsOf });
      note.hidden = false;
    }
    const r = $(".reveal-title", root).getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, 50);
  }

  // 2) 目標を選ぶ。過去の記録があれば「ふだんの1日」を目安としておすすめする (決めるのは本人)
  function suggest() {
    const typical = Math.min(4, Math.max(1, history?.typicalDay || 1));
    for (const c of $$("[data-goal-pick]", root)) {
      const rec = +c.dataset.goalPick === typical;
      c.classList.toggle("rec", rec);
      $(".goal-badge", c)?.remove();
      if (rec) c.insertAdjacentHTML("afterbegin", `<span class="goal-badge">${T("c.recommend")}</span>`);
    }
    if (history?.activeDays) {
      $("[data-suggest]", root).textContent = T("c.suggest", { typical: history.typicalDay, best: history.bestDay });
    }
    markGoal();
  }
  function markGoal() {
    // 一度選んだあとに戻ってきたら、その目標を選択済みにしておく
    for (const c of $$("[data-goal-pick]", root)) c.classList.toggle("selected", chosen && +c.dataset.goalPick === goal);
  }
  let chosen = false;
  for (const b of $$("[data-goal-pick]", root)) {
    b.addEventListener("click", async () => {
      goal = +b.dataset.goalPick;
      chosen = true;
      markGoal();
      b.classList.add("picked");
      setTimeout(() => b.classList.remove("picked"), 400);
      // ブラウザのタイムゾーンもここで保存する
      await post("/api/settings", { goal: +b.dataset.goalPick, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setTimeout(() => show(3), calm ? 0 : 260);
    });
  }

  for (const b of $$("[data-next]", root)) b.addEventListener("click", () => show(+b.dataset.next));
  // 戻る操作はブラウザの履歴を 1つ戻すのと同じにする (履歴が 1 → 2 → 3 の一直線のまま保たれる)
  const goBack = () => (window.history.state?.step === 3 ? window.history.back() : show(2));
  for (const b of $$("[data-back]", root)) b.addEventListener("click", goBack);
  $$(".steps li", root)[1]?.addEventListener("click", () => { if (step > 2) goBack(); });
  window.history.replaceState({ step: 1 }, "", location.pathname);
  show(1, { push: false });
  for (const b of $$("[data-finish]", root)) {
    b.addEventListener("click", async () => {
      await post("/api/onboarded");
      location.href = "/me";
    });
  }
})();

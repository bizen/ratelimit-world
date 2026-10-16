// ダッシュボードの動き: リセットまでのカウントダウン、通知の登録、設定の保存、コピー
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
        d.classList.remove("limited", "using");
        d.classList.add("ready");
        delete d.dataset.reset;
        $(".ring-text small", d).textContent = "今すぐ再開！";
        clock.textContent = "GO";
        continue;
      }
      const h = Math.floor(left / 3600000), m = Math.floor(left / 60000) % 60, s = Math.floor(left / 1000) % 60;
      clock.textContent = `${h}:${pad(m)}:${pad(s)}`;
      if (d.classList.contains("limited")) {
        const fill = $(".fill", d);
        fill.style.strokeDashoffset = (+fill.dataset.c * (1 - Math.min(1, left / WINDOW_MS))).toFixed(1);
      }
    }
    for (const d of $$(".dial.ready[data-since]")) {
      const min = Math.floor((now - +d.dataset.since) / 60000);
      $(".ring-text small", d).textContent = min > 0 ? `${min}分 出遅れ中` : "今すぐ再開！";
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
    try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = "コピーしました"; setTimeout(() => (btn.textContent = t), 1500); } catch {}
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
        body: JSON.stringify({ goal: f.get("goal"), remindAt: f.get("remindAt"), tz: f.get("tz"), notify, public: $("input[name=public]", form).checked }),
      });
      status.textContent = res.ok ? "保存しました" : "保存できませんでした。もう一度お試しください";
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
      enableBtn.textContent = on ? "この端末の通知を止める" : "この端末で通知を受け取る";
      enableBtn.dataset.on = on ? "1" : "";
      testBtn.hidden = !on;
    };

    (async () => {
      if (!supported) { enableBtn.disabled = true; status.textContent = "このブラウザは通知に対応していません。"; return; }
      if (!vapid) { enableBtn.disabled = true; status.textContent = "サーバーの通知設定（VAPID 鍵）がまだありません。"; return; }
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
        status.textContent = "この端末への通知を止めました";
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { status.textContent = "通知が許可されませんでした。ブラウザの設定から許可してください"; return; }
      try {
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapid) });
        const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
        if (!res.ok) throw new Error(String(res.status));
        setOn(true);
        status.textContent = "通知を受け取れるようになりました。テスト通知で確認できます";
      } catch (e) {
        status.textContent = `通知を登録できませんでした (${e.message})`;
      }
    });

    testBtn.addEventListener("click", async () => {
      const res = await fetch("/api/push/test", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
      status.textContent = res.ok ? "テスト通知を送りました" : "送れませんでした。通知をいったん止めて、もう一度受け取る設定にしてください";
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
        toast(`<b>${n}枠目「${tier}」</b> +${lastXp} XP${goalHit ? "<br>🔥 今日の目標達成！" : ""}${record ? "<br>1日の自己ベスト更新！" : ""}`);
      }, fresh.length * 180 + 250);
    }
    store.set("rw:seen", { day, count: n });
  }

  // ---------- /welcome ----------
  const root = $("[data-welcome]");
  if (!root) return;
  let step = 1;
  const show = (k) => {
    step = k;
    for (const el of $$(".step", root)) el.hidden = +el.dataset.step !== k;
    $$(".steps li", root).forEach((li, i) => li.classList.toggle("on", i < k));
    if (k === 1) poll();
    if (k === 2) suggest();
  };
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
  function reveal(h) {
    history = h;
    $("[data-link-wait]", root).hidden = true;
    $(".skip", root).hidden = true;
    $("[data-link-done]", root).hidden = false;
    countUp($('[data-h="total"]', root), h.total);
    countUp($('[data-h="avgLateMin"]', root), h.avgLateMin);
    countUp($('[data-h="bestDay"]', root), h.bestDay);
    const lost = h.lostMin >= 60 ? `${Math.floor(h.lostMin / 60)}時間${h.lostMin % 60}分` : `${h.lostMin}分`;
    $('[data-h="message"]', root).textContent = h.total === 0
      ? "まだ記録はありません。最初の1枠を使い切ったら、ここから🔥が始まります。"
      : h.avgLateMin
        ? `リセットに気づかず、合計 ${lost} を取りこぼしていました。これをゼロにしよう。`
        : "すでにいいペース。ここから毎日積み上げよう。";
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
      if (rec) c.insertAdjacentHTML("afterbegin", '<span class="goal-badge">おすすめ</span>');
    }
    if (history?.activeDays) {
      $("[data-suggest]", root).textContent = `あなたのふだんの1日は ${history.typicalDay} 枠、最多は ${history.bestDay} 枠でした。まずはふだんどおりの数から始めて、続けられたら上げましょう。`;
    }
  }
  for (const b of $$("[data-goal-pick]", root)) {
    b.addEventListener("click", async () => {
      b.classList.add("picked");
      // ブラウザのタイムゾーンもここで保存する
      await post("/api/settings", { goal: +b.dataset.goalPick, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setTimeout(() => show(3), calm ? 0 : 260);
    });
  }

  for (const b of $$("[data-next]", root)) b.addEventListener("click", () => show(+b.dataset.next));
  show(1);
  for (const b of $$("[data-finish]", root)) {
    b.addEventListener("click", async () => {
      await post("/api/onboarded");
      location.href = "/me";
    });
  }
})();

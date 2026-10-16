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

/* ================================================================== */
/* Markbase Content Tip — suggest related bookmarks on any page         */
/* ================================================================== */
(() => {
  const hostname = location.hostname;
  if (!hostname || hostname === "newtab" || location.protocol === "chrome-extension:") return;

  async function checkBookmarks() {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("markbase_ext", 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const metas = await new Promise((resolve) => {
        const tx = db.transaction("meta", "readonly");
        const r = tx.objectStore("meta").getAll();
        r.onsuccess = () => resolve(r.result);
      });

      // Find bookmarks matching this domain
      const matches = metas.filter(m => {
        try { return new URL(m.url).hostname === hostname; }
        catch { return false; }
      });

      if (matches.length === 0) return;

      // Check if recently dismissed
      const key = `markbase-tip-dismissed-${hostname}`;
      const dismissed = await new Promise(r => chrome.storage.local.get(key, d => r(d[key] || 0)));
      if (Date.now() - dismissed < 24 * 3600 * 1000) return;

      // Check total tips shown today
      const tipCount = await new Promise(r => chrome.storage.local.get("markbase-tip-count", d => r(d["markbase-tip-count"] || 0)));
      if (tipCount >= 3) return; // max 3 tips per day

      const top = matches.filter(m => m.summary).slice(0, 3);
      const items = top.map(m => {
        const scoreStars = m.score ? "⭐".repeat(Math.ceil(m.score / 2)) : "";
        const tags = (m.tags || []).slice(0, 4).map(t => `#${t}`).join(" ");
        return `<div class="mbt-item">
          <a href="${escUrl(m.url)}" target="_blank">${esc(m.title || "未命名")}</a>
          <div class="mbt-meta">${scoreStars} ${tags} ${m.category ? "📂" + esc(m.category) : ""}</div>
        </div>`;
      }).join("");

      // Show floating tip
      const tip = document.createElement("div");
      tip.className = "markbase-tip";
      tip.innerHTML = `
        <div class="mbt-header">
          <strong>📌 你收藏过此站的 ${matches.length} 条书签</strong>
          <button class="mbt-close" title="关闭">&times;</button>
        </div>
        <div class="mbt-list">${items}</div>
        <div class="mbt-footer"><button class="mbt-dismiss">今天不再提示此站</button></div>
      `;
      document.body.appendChild(tip);

      // Style
      const style = document.createElement("style");
      style.textContent = `
        .markbase-tip{position:fixed;top:16px;right:16px;z-index:999999;width:340px;max-height:90vh;overflow-y:auto;
          background:rgba(18,18,24,0.94);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
          border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:14px 16px;
          font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#f5f5f7;
          box-shadow:0 16px 50px rgba(0,0,0,0.5);animation:mbt-in 0.35s cubic-bezier(0.22,0,0,1)}
        @keyframes mbt-in{from{opacity:0;transform:translateY(-12px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}
        .mbt-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
        .mbt-header strong{font-size:14px;font-weight:700;letter-spacing:-0.01em}
        .mbt-close{width:24px;height:24px;border:none;background:rgba(255,255,255,0.06);border-radius:50%;color:#a1a1a6;font-size:16px;cursor:pointer;display:grid;place-items:center}
        .mbt-close:hover{background:rgba(255,255,255,0.12);color:#fff}
        .mbt-item{padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
        .mbt-item:last-child{border-bottom:none}
        .mbt-item a{color:#2997ff;text-decoration:none;font-weight:500;font-size:13px;display:block;margin-bottom:3px}
        .mbt-item a:hover{text-decoration:underline}
        .mbt-meta{font-size:11px;color:#6e6e73}
        .mbt-footer{margin-top:10px;text-align:right}
        .mbt-dismiss{background:none;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#6e6e73;font-size:11px;padding:4px 10px;cursor:pointer}
        .mbt-dismiss:hover{border-color:rgba(255,255,255,0.3);color:#a1a1a6}
      `;
      document.head.appendChild(style);

      // Events
      tip.querySelector(".mbt-close").addEventListener("click", () => tip.remove());
      tip.querySelector(".mbt-dismiss").addEventListener("click", async () => {
        await new Promise(r => chrome.storage.local.set({ [key]: Date.now() }, r));
        tip.remove();
      });

      // Track count
      const count = (await new Promise(r => chrome.storage.local.get("markbase-tip-count", d => r(d["markbase-tip-count"] || 0)))) + 1;
      await new Promise(r => chrome.storage.local.set({ "markbase-tip-count": count }, r));

      // Auto-dismiss after 20s
      setTimeout(() => { if (tip.parentElement) tip.remove(); }, 20000);
    } catch (e) { /* ignore */ }
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function escUrl(s) { return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // Run after page settles
  setTimeout(checkBookmarks, 2000);
})();

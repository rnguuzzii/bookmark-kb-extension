(() => {
  const $ = (s) => document.querySelector(s);

  const popupList = $("#popupList");
  const popupEmpty = $("#popupEmpty");
  const popupStat = $("#popupStat");
  const popupSearch = $("#popupSearch");
  const popupAiBtn = $("#popupAiBtn");
  const popupSyncBtn = $("#popupSyncBtn");

  let metas = [];
  let bookmarks = [];
  let searchQuery = "";

  function flattenTree(node) {
    const items = [];
    function walk(n) {
      if (n.url) items.push({ id: n.id, title: n.title, url: n.url, dateAdded: n.dateAdded });
      if (n.children) n.children.forEach(walk);
    }
    walk(node);
    return items;
  }

  async function loadData() {
    // Get metas from shared IndexedDB
    const DB_NAME = "markbase_ext";
    const DB_VERSION = 1;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    metas = await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Get live bookmarks
    const tree = await chrome.bookmarks.getTree();
    bookmarks = flattenTree(tree[0]);
  }

  function render() {
    const metaMap = new Map(metas.map(m => [m.bookmarkId, m]));
    let list = bookmarks.map(bm => {
      const m = metaMap.get(bm.id);
      return {
        id: bm.id, url: bm.url, title: bm.title, addedAt: bm.dateAdded || Date.now(),
        summary: m?.summary || "", category: m?.category || "", tags: m?.tags || []
      };
    });

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(b =>
        (b.title && b.title.toLowerCase().includes(q)) ||
        (b.url && b.url.toLowerCase().includes(q)) ||
        (b.summary && b.summary.toLowerCase().includes(q))
      );
    }

    // Sort newest first
    list.sort((a, b) => b.addedAt - a.addedAt);

    // Show top 20
    const display = list.slice(0, 20);

    if (display.length === 0) {
      popupList.style.display = "none";
      popupEmpty.style.display = "";
    } else {
      popupList.style.display = "";
      popupEmpty.style.display = "none";
      popupList.innerHTML = display.map(b => {
        const domain = (() => { try { return new URL(b.url).hostname; } catch { return ""; } })();
        const badge = b.summary ? '<span class="popup-item-badge">AI</span>' : "";
        return `
        <a class="popup-item" href="${esc(b.url)}" target="_blank" title="${esc(b.title)}">
          <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" loading="lazy" onerror="this.style.display='none'">
          <div class="popup-item-info">
            <div class="popup-item-title">${esc(b.title)}</div>
            <div class="popup-item-url">${esc(domain)}</div>
          </div>
          ${badge}
        </a>`;
      }).join("");
    }

    popupStat.textContent = `${bookmarks.length} 条书签 · ${metas.filter(m => m.summary).length} 已分析`;
    const unprocessed = bookmarks.length - metas.filter(m => m.summary).length;
    popupAiBtn.textContent = unprocessed > 0 ? `AI 分析 (${unprocessed})` : "全部已分析";
    popupAiBtn.disabled = unprocessed === 0;
  }

  // Search
  let searchTimer;
  popupSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = popupSearch.value.trim();
      render();
    }, 150);
  });

  // Sync
  popupSyncBtn.addEventListener("click", async () => {
    popupSyncBtn.style.transform = "rotate(180deg)";
    popupSyncBtn.style.transition = "transform 0.6s ease";
    await chrome.runtime.sendMessage({ type: "SYNC" });
    await loadData();
    render();
    setTimeout(() => { popupSyncBtn.style.transform = ""; }, 600);
  });

  // AI batch - just open the dashboard
  popupAiBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  // Click on search focuses it
  popupSearch.focus();

  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function init() {
    try { await chrome.runtime.sendMessage({ type: "SYNC" }); } catch (e) { /* OK */ }
    await loadData();
    render();
  }

  init();
})();

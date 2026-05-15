(() => {
  /* ================================================================== */
  /* IndexedDB (shared with background)                                  */
  /* ================================================================== */
  const DB_NAME = "markbase_ext";
  const DB_VERSION = 2;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) {
          const store = db.createObjectStore("meta", { keyPath: "bookmarkId" });
          store.createIndex("category", "category", { unique: false });
          store.createIndex("addedAt", "addedAt", { unique: false });
          store.createIndex("tags", "tags", { unique: false, multiEntry: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function metaPut(record) {
    return openDB().then(db => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(record);
      return new Promise(r => { tx.oncomplete = r; });
    });
  }

  function metaGetAll() {
    return openDB().then(db => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").getAll();
      return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    });
  }

  function metaDelete(id) {
    return openDB().then(db => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").delete(id);
      return new Promise(r => { tx.oncomplete = r; });
    });
  }

  /* ================================================================== */
  /* Settings (chrome.storage)                                           */
  /* ================================================================== */
  const DEFAULT_SETTINGS = {
    provider: "deepseek",
    dsKey: "", dsEndpoint: "https://api.deepseek.com/v1/chat/completions", dsModel: "deepseek-chat",
    qwenKey: "", qwenEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", qwenModel: "qwen-turbo", qwenVisionModel: "qwen-vl-plus",
    doubaoKey: "", doubaoEndpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", doubaoModel: "doubao-pro-32k", doubaoVisionModel: "doubao-1-5-vision-pro-32k",
    customName: "", customKey: "", customEndpoint: "", customModel: "", customVisionModel: "",
    chatProvider: "deepseek",
    visionProvider: "qwen",
    analysisProvider: "deepseek"
  };

  async function getSettings() {
    const data = await chrome.storage.local.get("api");
    return data.api ? { ...DEFAULT_SETTINGS, ...data.api } : { ...DEFAULT_SETTINGS };
  }

  async function saveSettings(s) {
    await chrome.storage.local.set({ api: s });
  }

  /* ================================================================== */
  /* DOM                                                                 */
  /* ================================================================== */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const loader = $("#loader");
  const sidebar = $("#sidebar");
  const searchInput = $("#searchInput");
  const searchClear = $("#searchClear");
  const bookmarkGrid = $("#bookmarkGrid");
  const emptyState = $("#emptyState");
  const categoryList = $("#categoryList");
  const tagCloud = $("#tagCloud");
  const statTotal = $("#statTotal");
  const statTagged = $("#statTagged");
  const toolbarTitle = $("#toolbarTitle");
  const toolbarCount = $("#toolbarCount");
  const sortSelect = $("#sortSelect");
  const settingsOverlay = $("#settingsOverlay");
  const detailOverlay = $("#detailOverlay");
  const detailPanel = $("#detailPanel");
  const detailContent = $("#detailContent");
  const toast = $("#toast");
  const toastMsg = $("#toastMsg");
  const toastBar = $("#toastBar");

  /* ================================================================== */
  /* State                                                               */
  /* ================================================================== */
  let metas = [];
  let bookmarks = []; // live chrome.bookmarks data
  let activeCategory = "all";
  let activeTag = null;
  let searchQuery = "";
  let sortBy = "newest";

  /* ================================================================== */
  /* Data Loading                                                        */
  /* ================================================================== */
  async function loadData() {
    // Load metas from shared IndexedDB
    metas = await metaGetAll();

    // Load live bookmarks from Chrome API
    const tree = await chrome.bookmarks.getTree();
    bookmarks = flattenTree(tree[0]);
  }

  function flattenTree(node) {
    const items = [];
    function walk(n) {
      if (n.url) items.push({ id: n.id, title: n.title, url: n.url, dateAdded: n.dateAdded, parentId: n.parentId });
      if (n.children) n.children.forEach(walk);
    }
    walk(node);
    return items;
  }

  /* ================================================================== */
  /* Merge meta into bookmarks for display                               */
  /* ================================================================== */
  function mergedList() {
    const metaMap = new Map(metas.map(m => [m.bookmarkId, m]));
    return bookmarks.map(bm => {
      const m = metaMap.get(bm.id);
      return {
        id: bm.id,
        url: bm.url,
        title: bm.title,
        addedAt: bm.dateAdded || Date.now(),
        category: m?.category || "",
        tags: m?.tags || [],
        summary: m?.summary || "",
        notes: m?.notes || "",
        score: m?.score || 0,
        scoreReason: m?.scoreReason || "",
        smartFolder: m?.smartFolder || [],
        thumbnails: m?.thumbnails || [],
        status: m?.status || "unread"
      };
    });
  }

  /* ================================================================== */
  /* Filter & Render                                                     */
  /* ================================================================== */
  function getFiltered() {
    let list = mergedList();

    if (activeCategory === "uncategorized") {
      list = list.filter(b => !b.category || b.category === "未分类");
    } else if (activeCategory !== "all") {
      list = list.filter(b => b.category === activeCategory);
    }
    if (activeTag) {
      list = list.filter(b => b.tags.includes(activeTag));
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(b =>
        (b.title && b.title.toLowerCase().includes(q)) ||
        (b.url && b.url.toLowerCase().includes(q)) ||
        (b.summary && b.summary.toLowerCase().includes(q)) ||
        (b.tags && b.tags.some(t => t.toLowerCase().includes(q))) ||
        (b.category && b.category.toLowerCase().includes(q)) ||
        (b.notes && b.notes.toLowerCase().includes(q))
      );
    }

    if (sortBy === "oldest") list.sort((a, b) => a.addedAt - b.addedAt);
    else if (sortBy === "title") list.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else list.sort((a, b) => b.addedAt - a.addedAt);

    return list;
  }

  function render() {
    const filtered = getFiltered();

    statTotal.textContent = bookmarks.length;
    statTagged.textContent = metas.filter(m => m.summary).length;
    toolbarCount.textContent = `${filtered.length} 项`;

    // Categories
    const catMap = {};
    for (const b of mergedList()) {
      const c = b.category || "未分类";
      catMap[c] = (catMap[c] || 0) + 1;
    }
    const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

    let catHTML = `<button class="category-item ${activeCategory === 'all' && !activeTag ? 'active' : ''}" data-category="all">全部<span class="category-count">${bookmarks.length}</span></button>`;
    catHTML += `<button class="category-item ${activeCategory === 'uncategorized' ? 'active' : ''}" data-category="uncategorized">未分类</button>`;
    for (const [name, count] of cats) {
      if (name === "未分类") continue;
      catHTML += `<button class="category-item ${activeCategory === name ? 'active' : ''}" data-category="${esc(name)}">${esc(name)}<span class="category-count">${count}</span></button>`;
    }
    categoryList.innerHTML = catHTML;

    // Tags
    const tagMap = {};
    for (const b of mergedList()) {
      for (const t of b.tags) tagMap[t] = (tagMap[t] || 0) + 1;
    }
    const tags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 30);
    let tagHTML = "";
    for (const [name, count] of tags) {
      tagHTML += `<button class="tag-item ${activeTag === name ? 'active' : ''}" data-tag="${esc(name)}">${esc(name)} <small>${count}</small></button>`;
    }
    tagCloud.innerHTML = tagHTML || '<span style="font-size:12px;color:var(--text-tertiary)">暂无标签</span>';

    // Grid
    if (filtered.length === 0) {
      bookmarkGrid.innerHTML = "";
      bookmarkGrid.appendChild(emptyState);
      emptyState.style.display = "";
    } else {
      emptyState.style.display = "none";
      bookmarkGrid.innerHTML = filtered.map(b => cardHTML(b)).join("");
    }

    bindCategoryEvents();
    bindTagEvents();
  }

  function cardHTML(b) {
    const tagsHTML = (b.tags || []).slice(0, 8).map(t => `<span class="bm-tag">${esc(t)}</span>`).join("");
    const summaryHTML = b.summary ? `<p class="bm-summary">${esc(b.summary)}</p>` : "";
    const catHTML = b.category && b.category !== "未分类" ? `<span class="bm-category">${esc(b.category)}</span>` : "";
    const aiBadge = b.summary ? '<span class="ai-badge">AI</span>' : "";
    const statusBadge = b.status === "read"
      ? '<span class="bm-status bm-status-read" data-action="status" data-id="' + b.id + '" data-status="read">✓ 已读</span>'
      : '<span class="bm-status bm-status-unread" data-action="status" data-id="' + b.id + '" data-status="unread">○ 待读</span>';
    const scoreBadge = b.score ? `<span class="bm-score">⭐ ${b.score}/10 ${b.scoreReason||""}</span>` : "";
    const sfBadge = b.smartFolder?.length ? b.smartFolder.map(f => `<span class="bm-smart-folder">📁 ${esc(f)}</span>`).join("") : "";
    const thumbHTML = b.thumbnails?.length > 0
      ? `<img class="bm-thumb" src="${esc(b.thumbnails[0].url)}" loading="lazy" onerror="this.style.display='none'" alt="">`
      : "";
    const domain = (() => { try { return new URL(b.url).hostname; } catch { return ""; } })();

    return `
    <article class="bm-card" data-id="${b.id}">
      ${thumbHTML}
      <div class="bm-card-header">
        <div class="bm-favicon"><img src="https://logo.clearbit.com/${domain}?size=32" loading="lazy" onerror="this.style.display='none'"></div>
        <div style="flex:1;min-width:0">
          <div class="bm-title"><a href="${esc(b.url)}" target="_blank" rel="noopener" title="${esc(b.title)}">${esc(b.title)}</a></div>
          <div class="bm-url">${esc(domain)}</div>
        </div>
      </div>
      ${summaryHTML}
      <div class="bm-meta">${aiBadge}${statusBadge} ${catHTML} ${scoreBadge} <span>${timeAgo(b.addedAt)}</span>${sfBadge}</div>
      <div class="bm-tags">${tagsHTML}</div>
      <div class="bm-actions">
        <button class="bm-action-btn" data-action="view" data-id="${b.id}">详情</button>
        <button class="bm-action-btn" data-action="ai" data-id="${b.id}" ${b.summary ? "" : 'style="color:var(--accent)"'}>${b.summary ? "重新分析" : "AI 分析"}</button>
        <button class="bm-action-btn danger" data-action="delete" data-id="${b.id}">删除</button>
      </div>
    </article>`;
  }

  /* ================================================================== */
  /* Event Binding                                                       */
  /* ================================================================== */
  bookmarkGrid.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "view") openDetail(id);
    if (btn.dataset.action === "ai") await runSingleAI(id);
    if (btn.dataset.action === "status") { await toggleStatus(id, btn.dataset.status); }
    if (btn.dataset.action === "delete") {
      if (confirm("确认删除这个书签？（会从浏览器中删除）")) {
        await chrome.bookmarks.remove(id);
        await metaDelete(id);
        await refresh();
        render();
        showToast("已删除");
      }
    }
  });

  function bindCategoryEvents() {
    categoryList.querySelectorAll(".category-item").forEach(el => {
      el.addEventListener("click", () => {
        activeCategory = el.dataset.category;
        activeTag = null;
        toolbarTitle.textContent = activeCategory === "all" ? "全部书签" : activeCategory;
        render();
      });
    });
  }

  function bindTagEvents() {
    tagCloud.querySelectorAll(".tag-item").forEach(el => {
      el.addEventListener("click", () => {
        const tag = el.dataset.tag;
        if (activeTag === tag) { activeTag = null; activeCategory = "all"; toolbarTitle.textContent = "全部书签"; }
        else { activeTag = tag; activeCategory = "all"; toolbarTitle.textContent = `#${tag}`; }
        render();
      });
    });
  }

  /* ================================================================== */
  /* Detail Panel                                                        */
  /* ================================================================== */
  function openDetail(id) {
    const list = mergedList();
    const b = list.find(x => x.id === id);
    if (!b) return;
    const domain = (() => { try { return new URL(b.url).hostname; } catch { return ""; } })();
    const tagsHTML = (b.tags || []).map(t => `<span class="bm-tag">${esc(t)}</span>`).join(" ");

    const detailThumbs = b.thumbnails?.length
      ? `<div class="detail-section"><h4>页面缩略图</h4><div class="detail-thumbs">${b.thumbnails.slice(0,6).map(t => `<a href="${esc(t.url)}" target="_blank"><img src="${esc(t.url)}" loading="lazy" onerror="this.parentElement.style.display='none'" title="${esc(t.source)}"></a>`).join("")}</div></div>`
      : "";

    detailContent.innerHTML = `
      <h2>${esc(b.title)}</h2>
      <div class="detail-url"><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.url)}</a></div>
      ${b.summary ? `<div class="detail-summary">${esc(b.summary)}</div>` : '<div class="detail-summary" style="color:var(--text-tertiary)">暂无 AI 摘要</div>'}
      ${detailThumbs}
      <div class="detail-section"><h4>分类</h4><span class="bm-category">${esc(b.category || "未分类")}</span> ${b.score ? `<span class="bm-score">⭐ ${b.score}/10</span>` : ""}</div>
      <div class="detail-section"><h4>标签</h4><div class="bm-tags">${tagsHTML || '<span style="color:var(--text-tertiary);font-size:13px">无</span>'}</div></div>
      ${b.notes ? `<div class="detail-section"><h4>备注</h4><div class="detail-notes">${esc(b.notes)}</div></div>` : ""}
      <div class="detail-section"><h4>添加时间</h4><span style="font-size:13px;color:var(--text-secondary)">${new Date(b.addedAt).toLocaleString("zh-CN")}</span></div>
      <div class="detail-section"><h4>域名</h4><span style="font-size:13px;color:var(--text-secondary)">${domain}</span></div>
      <div style="display:flex;gap:8px;margin-top:20px">
        <button class="btn btn-primary" data-action="ai" data-id="${b.id}">${b.summary ? "重新 AI 分析" : "AI 分析"}</button>
        <button class="bm-action-btn danger" data-action="delete" data-id="${b.id}">删除</button>
      </div>
    `;

    detailContent.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const aid = btn.dataset.id;
        if (btn.dataset.action === "ai") { closeDetail(); await runSingleAI(aid); }
        if (btn.dataset.action === "delete") {
          if (confirm("确认删除？")) { await chrome.bookmarks.remove(aid); await metaDelete(aid); await refresh(); render(); closeDetail(); }
        }
      });
    });

    detailOverlay.style.display = "";
    detailPanel.style.display = "";
  }

  function closeDetail() { detailOverlay.style.display = "none"; detailPanel.style.display = "none"; }
  detailOverlay.addEventListener("click", closeDetail);
  $("#detailClose").addEventListener("click", closeDetail);

  /* ================================================================== */
  /* AI Processing (uses LLM module)                                     */
  /* ================================================================== */
  async function runSingleAI(id) {
    const list = mergedList();
    const b = list.find(x => x.id === id);
    if (!b) return;
    showToast("抓取页面内容...");
    try {
      const result = await LLM.deepAnalyze({
        url: b.url,
        title: b.title,
        onProgress: (msg) => showToast(msg)
      });
      const record = {
        bookmarkId: id,
        url: b.url,
        title: b.title,
        summary: result.summary || "",
        category: result.category || "未分类",
        tags: result.tags || [],
        thumbnails: result.thumbnails || [],
        notes: (metas.find(m => m.bookmarkId === id)?.notes) || "",
        needsAnalysis: false,
        addedAt: b.addedAt
      };
      await metaPut(record);
      await refresh();
      render();
      const detail = result.hasVision ? " (含图片识别)" : "";
      const source = result.hasPageContent ? "深度分析" : "标题分析";
      showToast(`${source}完成${detail}`);
    } catch (err) { showToast(`失败: ${err.message}`); }
  }

  async function runBatchAI() {
    const list = mergedList().filter(b => !b.summary);
    if (list.length === 0) { showToast("所有书签已分析完毕"); return; }

    const btn = $("#batchAiBtn");
    btn.disabled = true;
    let done = 0;

    for (const b of list) {
      btn.textContent = `处理中 ${done + 1}/${list.length}`;
      showToast(`AI 分析中... ${done + 1}/${list.length}`, true);
      try {
        const result = await LLM.deepAnalyze({
          url: b.url,
          title: b.title,
          onProgress: (msg) => showToast(`${msg} (${done + 1}/${list.length})`, true)
        });
        await metaPut({
          bookmarkId: b.id, url: b.url, title: b.title,
          summary: result.summary || "",
          category: result.category || "未分类",
          tags: result.tags || [],
          thumbnails: result.thumbnails || [],
          notes: (metas.find(m => m.bookmarkId === b.id)?.notes) || "",
          needsAnalysis: false,
          addedAt: Date.now()
        });
        done++;
      } catch (err) {
        showToast(`跳过: ${err.message}`);
        done++;
        continue;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    await refresh();
    render();
    btn.textContent = "AI 批处理";
    btn.disabled = false;
    showToast(`完成！已处理 ${done}/${list.length} 条`);
  }

  $("#batchAiBtn").addEventListener("click", runBatchAI);
  $("#reanalyzeAllBtn").addEventListener("click", runReanalyzeAll);

  async function runReanalyzeAll() {
    const all = mergedList().filter(b => b.summary).sort((a, b) => a.addedAt - b.addedAt); // oldest first, each batch moves forward
    if (all.length === 0) { showToast("没有已分析的书签可重新分析"); return; }

    const batchSize = parseInt(document.getElementById("batchCount")?.value || "20", 10);
    const list = all.slice(0, batchSize);
    if (!confirm(`共 ${all.length} 条已分析。本次取前 ${list.length} 条深度重新分析（页面抓取 + 图片识别）。继续？`)) return;

    const btn = $("#reanalyzeAllBtn");
    btn.disabled = true;
    let done = 0;

    for (const b of list) {
      btn.textContent = `重新分析 ${done + 1}/${list.length}`;
      showToast(`深度重新分析... ${done + 1}/${list.length}`, true);
      try {
        const result = await LLM.deepAnalyze({
          url: b.url,
          title: b.title,
          onProgress: (msg) => showToast(`${msg} (${done + 1}/${list.length})`, true)
        });
        await metaPut({
          bookmarkId: b.id, url: b.url, title: b.title,
          summary: result.summary || "",
          category: result.category || "未分类",
          tags: result.tags || [],
          thumbnails: result.thumbnails || [],
          notes: (metas.find(m => m.bookmarkId === b.id)?.notes) || "",
          needsAnalysis: false,
          addedAt: Date.now()
        });
        done++;
      } catch (err) {
        showToast(`跳过: ${err.message}`);
        done++;
        continue;
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Remove processed from the front of the list in UI — they stay in data
    all.splice(0, done);

    await refresh();
    render();
    btn.textContent = "深度重新分析";
    btn.disabled = false;
    showToast(`完成！已重新分析 ${done} 条，剩余约 ${Math.max(0, all.length)} 条`);
  }

  /* ================================================================== */
  /* Sync                                                                */
  /* ================================================================== */
  async function sync() {
    showToast("正在同步浏览器书签...");
    const result = await chrome.runtime.sendMessage({ type: "SYNC" });
    await refresh();
    render();
    showToast(`同步完成：${result.total} 条书签`);
  }

  async function refresh() {
    await loadData();
  }

  $("#syncBtn").addEventListener("click", sync);
  $("#emptySyncBtn").addEventListener("click", sync);

  /* ================================================================== */
  /* Add Bookmark                                                        */
  /* ================================================================== */
  $("#addBtn").addEventListener("click", async () => {
    const url = prompt("输入网址：", "https://");
    if (!url) return;
    const title = prompt("输入标题：", "") || url;
    try {
      const bm = await chrome.bookmarks.create({ title, url });
      await metaPut({
        bookmarkId: bm.id, url, title,
        category: "", tags: [], summary: "", notes: "",
        addedAt: bm.dateAdded || Date.now()
      });
      await refresh();
      render();
      showToast("已添加");
    } catch (err) { showToast(`添加失败: ${err.message}`); }
  });

  /* ================================================================== */
  /* Export                                                              */
  /* ================================================================== */
  $("#exportBtn").addEventListener("click", () => {
    const data = JSON.stringify(mergedList(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `markbase-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${bookmarks.length} 条`);
  });

  /* ================================================================== */
  /* Settings Modal                                                      */
  /* ================================================================== */
  async function openSettings() {
    const s = await getSettings();
    $("#dsKey").value = s.dsKey || ""; $("#dsEndpoint").value = s.dsEndpoint; $("#dsModel").value = s.dsModel;
    $("#qwenKey").value = s.qwenKey || ""; $("#qwenEndpoint").value = s.qwenEndpoint; $("#qwenModel").value = s.qwenModel;
    const qvm = document.getElementById("qwenVisionModel"); if (qvm) qvm.value = s.qwenVisionModel || "qwen-vl-plus";
    $("#doubaoKey").value = s.doubaoKey || ""; $("#doubaoEndpoint").value = s.doubaoEndpoint; $("#doubaoModel").value = s.doubaoModel;
    const dvm = document.getElementById("doubaoVisionModel"); if (dvm) dvm.value = s.doubaoVisionModel || "doubao-1-5-vision-pro-32k";

    // Custom provider
    const cn = document.getElementById("customName"); if (cn) cn.value = s.customName || "";
    const ck = document.getElementById("customKey"); if (ck) ck.value = s.customKey || "";
    const ce = document.getElementById("customEndpoint"); if (ce) ce.value = s.customEndpoint || "";
    const cm = document.getElementById("customModel"); if (cm) cm.value = s.customModel || "";
    const cvm = document.getElementById("customVisionModel"); if (cvm) cvm.value = s.customVisionModel || "";

    // Task routing
    const chatSel = document.getElementById("chatProvider");
    const visionSel = document.getElementById("visionProvider");
    const analysisSel = document.getElementById("analysisProvider");
    if (chatSel) chatSel.value = s.chatProvider || "deepseek";
    if (visionSel) visionSel.value = s.visionProvider || "qwen";
    if (analysisSel) analysisSel.value = s.analysisProvider || "deepseek";

    // Activate correct tab
    $$(".settings-tab").forEach(t => t.classList.toggle("active", t.dataset.provider === s.provider));
    showSettingsPanel(s.provider);
    settingsOverlay.style.display = "";
  }

  function showSettingsPanel(provider) {
    $$(".settings-panel").forEach(p => p.style.display = "none");
    const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
    const panel = $(`#panel${cap}`);
    if (panel) panel.style.display = "";
  }

  function closeSettings() { settingsOverlay.style.display = "none"; }
  $("#settingsBtn").addEventListener("click", openSettings);
  settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) closeSettings(); });
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsCancel").addEventListener("click", closeSettings);

  $$(".settings-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".settings-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      showSettingsPanel(tab.dataset.provider);
    });
  });

  $("#settingsSave").addEventListener("click", async () => {
    const activeTab = document.querySelector(".settings-tab.active");
    const provider = activeTab?.dataset.provider || "deepseek";
    const chatSel = document.getElementById("chatProvider");
    const visionSel = document.getElementById("visionProvider");
    const analysisSel = document.getElementById("analysisProvider");

    const getVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };

    await saveSettings({
      provider,
      dsKey: getVal("dsKey"), dsEndpoint: getVal("dsEndpoint"), dsModel: getVal("dsModel"),
      qwenKey: getVal("qwenKey"), qwenEndpoint: getVal("qwenEndpoint"), qwenModel: getVal("qwenModel"), qwenVisionModel: getVal("qwenVisionModel"),
      doubaoKey: getVal("doubaoKey"), doubaoEndpoint: getVal("doubaoEndpoint"), doubaoModel: getVal("doubaoModel"), doubaoVisionModel: getVal("doubaoVisionModel"),
      customName: getVal("customName"), customKey: getVal("customKey"), customEndpoint: getVal("customEndpoint"), customModel: getVal("customModel"), customVisionModel: getVal("customVisionModel"),
      chatProvider: chatSel ? chatSel.value : "deepseek",
      visionProvider: visionSel ? visionSel.value : "qwen",
      analysisProvider: analysisSel ? analysisSel.value : "deepseek"
    });
    closeSettings();
    ChatManager.refreshModels();
    showToast("API 设置已保存");
  });

  /* ================================================================== */
  /* Search & Sort                                                       */
  /* ================================================================== */
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      searchClear.style.display = searchQuery ? "" : "none";
      render();
    }, 200);
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    searchClear.style.display = "none";
    render();
  });
  sortSelect.addEventListener("change", () => { sortBy = sortSelect.value; render(); });

  /* ================================================================== */
  /* Sidebar Toggle                                                      */
  /* ================================================================== */
  $("#sidebarToggle").addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    const svg = $("#sidebarToggle").querySelector("svg");
    svg.innerHTML = sidebar.classList.contains("collapsed")
      ? '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  });

  /* ================================================================== */
  /* Toast                                                               */
  /* ================================================================== */
  let toastTimer;
  function showToast(msg, persistent = false) {
    clearTimeout(toastTimer);
    toast.style.display = "";
    toastMsg.textContent = msg;
    toastBar.style.width = "0%";
    if (persistent) return;
    let w = 0;
    const animate = () => { w += 2; toastBar.style.width = `${Math.min(w, 100)}%`; if (w < 100) requestAnimationFrame(animate); };
    requestAnimationFrame(animate);
    toastTimer = setTimeout(() => { toast.style.display = "none"; }, 2500);
  }

  /* ================================================================== */
  /* Keyboard                                                            */
  /* ================================================================== */
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); searchInput.focus(); }
    if (e.key === "Escape") { closeDetail(); closeSettings(); }
  });

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */
  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(ts).toLocaleDateString("zh-CN");
  }

  /* ================================================================== */
  /* New Feature Handlers                                                 */
  /* ================================================================== */

  async function toggleStatus(id, current) {
    const meta = metas.find(m => m.bookmarkId === id);
    if (meta) {
      meta.status = current === "unread" ? "read" : "unread";
      await metaPut(meta);
      await refresh();
      render();
    }
  }

  // Theme toggle
  document.getElementById("themeToggle").addEventListener("click", () => {
    const html = document.documentElement;
    const isLight = html.dataset.theme === "light";
    html.dataset.theme = isLight ? "" : "light";
    document.getElementById("themeToggle").textContent = isLight ? "☀" : "🌙";
    localStorage.setItem("markbase-theme", isLight ? "dark" : "light");
  });
  // Restore theme
  if (localStorage.getItem("markbase-theme") === "light") {
    document.documentElement.dataset.theme = "light";
    document.getElementById("themeToggle").textContent = "🌙";
  }

  // View toggle
  let isListView = localStorage.getItem("markbase-view") === "list";
  if (isListView) { bookmarkGrid.classList.add("list-view"); document.getElementById("viewToggle").textContent = "⬜"; }
  document.getElementById("viewToggle").addEventListener("click", () => {
    isListView = !isListView;
    bookmarkGrid.classList.toggle("list-view", isListView);
    document.getElementById("viewToggle").textContent = isListView ? "⬜" : "☰";
    localStorage.setItem("markbase-view", isListView ? "list" : "card");
  });

  // Score bookmarks
  document.getElementById("scoreBtn").addEventListener("click", async () => {
    const metas = await Features.getMetas();
    const unscored = metas.filter(m => m.summary && (!m.score || m.score === 0)).length;
    let force = false;
    if (unscored === 0) {
      const scored = metas.filter(m => m.summary).length;
      if (!confirm(`所有 ${scored} 条已评分。是否用新标准强制重新评分全部？`)) return;
      force = true;
    } else if (unscored < metas.filter(m => m.summary).length) {
      if (confirm(`${unscored} 条未评分，${metas.filter(m => m.summary).length - unscored} 条已评分。\n点「确定」只评未评的\n点「取消」强制全部重新评分`)) {
        force = false;
      } else {
        force = true;
      }
    }
    showToast("AI 书签评分中...");
    const result = await Features.scoreBookmarks(
      (msg) => showToast(msg, true), 30, force
    );
    await refresh();
    render();
    showToast(result.msg);
  });

  // Smart folders
  document.getElementById("smartFolderBtn").addEventListener("click", async () => {
    showToast("AI 智能分组中...");
    const result = await Features.smartFolders(
      (msg) => showToast(msg, true)
    );
    await refresh();
    render();
    showToast(result.msg);
  });

  // Weekly report
  document.getElementById("weeklyBtn").addEventListener("click", async () => {
    document.getElementById("reportPanel").style.display = "";
    document.getElementById("graphPanel").style.display = "none";
    document.getElementById("randomPanel").style.display = "none";
    emptyState.style.display = "none";
    bookmarkGrid.style.display = "none";

    const content = document.getElementById("reportContent");
    content.innerHTML = `<p style="text-align:center;padding:40px;color:var(--text-tertiary)">生成周报中...</p>`;
    const report = await Features.weeklyReport((msg) => showToast(msg));

    const catChips = report.topCats?.map(c => `<span class="bm-tag">${c}</span>`).join(" ") || "";
    const tagChips = report.topTags?.map(t => `<span class="bm-tag">${t}</span>`).join(" ") || "";

    content.innerHTML = `
      <h2>📊 书签周报</h2>
      <p style="color:var(--text-secondary)">${report.summary}</p>
      <div class="stat-grid">
        <div class="stat-card"><strong>${report.newCount}</strong><span>本周新增</span></div>
        <div class="stat-card"><strong>${report.unread}</strong><span>待读</span></div>
        <div class="stat-card"><strong>${report.avgScore}</strong><span>平均评分</span></div>
      </div>
      <h3>活跃分类</h3><p>${catChips}</p>
      <h3>热门标签</h3><p>${tagChips}</p>
      ${report.best ? `<h3>🏆 高分推荐</h3><div class="pick-card"><h4>${esc(report.best.title)}</h4><span class="bm-score">⭐ ${report.best.score}/10</span></div>` : ""}
      ${report.oldUnread ? `<h3>📖 还未读的老朋友</h3><div class="pick-card"><h4>${esc(report.oldUnread.title)}</h4><span>${Features.timeAgo(report.oldUnread.addedAt)}收藏的，该读啦</span></div>` : ""}
    `;
  });

  // Random discovery
  document.getElementById("randomBtn").addEventListener("click", async () => {
    const metas = await Features.getMetas();
    const pick = Features.randomDiscovery(metas);
    if (!pick) { showToast("暂无已分析书签"); return; }

    document.getElementById("randomPanel").style.display = "";
    document.getElementById("reportPanel").style.display = "none";
    document.getElementById("graphPanel").style.display = "none";
    emptyState.style.display = "none";
    bookmarkGrid.style.display = "none";

    const domain = (() => { try { return new URL(pick.url).hostname; } catch { return ""; } })();
    document.getElementById("randomContent").innerHTML = `
      <h2>🎲 随机发现</h2>
      <p style="color:var(--text-secondary)">你收藏于 <strong>${Features.timeAgo(pick.addedAt)}</strong>，该再看看了。</p>
      <div class="pick-card">
        <h4><a href="${esc(pick.url)}" target="_blank" rel="noopener">${esc(pick.title)}</a></h4>
        <p style="color:var(--text-secondary)">${esc(pick.summary || "")}</p>
        <div class="pick-meta">
          <span>📂 ${esc(pick.category || "未分类")}</span>
          ${pick.score ? `<span>⭐ ${pick.score}/10</span>` : ""}
          ${pick.smartFolder?.length ? `<span>📁 ${pick.smartFolder.join(" / ")}</span>` : ""}
        </div>
        <div style="margin-top:8px">${(pick.tags||[]).map(t => `<span class="bm-tag">${esc(t)}</span>`).join(" ")}</div>
      </div>
    `;
  });

  // Graph
  document.getElementById("graphBtn").addEventListener("click", async () => {
    document.getElementById("graphPanel").style.display = "";
    document.getElementById("reportPanel").style.display = "none";
    document.getElementById("randomPanel").style.display = "none";
    emptyState.style.display = "none";
    bookmarkGrid.style.display = "none";
    const metas = await Features.getMetas();
    Features.renderGraph(document.getElementById("graphCanvas"), metas);
  });

  // Batch thumbnails
  document.getElementById("thumbBtn").addEventListener("click", async () => {
    showToast("抓取缩略图中...");
    const allMetas = await Features.getMetas();
    const result = await Features.batchFetchThumbnails(allMetas, (msg) => showToast(msg, true));
    await refresh();
    render();
    showToast(result.msg);
  });

  // Export Markdown
  document.getElementById("exportMdBtn").addEventListener("click", async () => {
    const metas = await Features.getMetas();
    const md = Features.exportMarkdown(metas);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `markbase-knowledge-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${metas.length} 条书签到 Markdown`);
  });

  // Panel close buttons
  document.getElementById("graphClose").addEventListener("click", () => { document.getElementById("graphPanel").style.display = "none"; render(); });
  document.getElementById("reportClose").addEventListener("click", () => { document.getElementById("reportPanel").style.display = "none"; render(); });
  document.getElementById("randomClose").addEventListener("click", () => { document.getElementById("randomPanel").style.display = "none"; render(); });

  // Restore grid view when needed
  const origRender = render;
  render = function() {
    document.getElementById("graphPanel").style.display = "none";
    document.getElementById("reportPanel").style.display = "none";
    document.getElementById("randomPanel").style.display = "none";
    bookmarkGrid.style.display = "";
    origRender();
  };

  /* ================================================================== */
  /* Init                                                                */
  /* ================================================================== */
  async function init() {
    try {
      await chrome.runtime.sendMessage({ type: "SYNC" });
    } catch (e) { /* OK */ }
    await loadData();
    render();

    // Init chat manager
    ChatManager.init(document.getElementById("chatWindow"));

    // Auto-process new bookmarks that need analysis
    const needAnalysis = metas.filter(m => m.needsAnalysis);
    if (needAnalysis.length > 0) {
      showToast(`检测到 ${needAnalysis.length} 条新书签，自动分析中...`);
      for (let i = 0; i < needAnalysis.length; i++) {
        const b = needAnalysis[i];
        showToast(`自动分析新书签 ${i + 1}/${needAnalysis.length}`, true);
        try {
          const result = await LLM.deepAnalyze({
            url: b.url, title: b.title,
            onProgress: (msg) => showToast(`${msg} (${i + 1}/${needAnalysis.length})`, true)
          });
          b.summary = result.summary; b.category = result.category; b.tags = result.tags;
          b.thumbnails = result.thumbnails || []; b.needsAnalysis = false;
          await metaPut(b);
        } catch (e) { b.needsAnalysis = true; await metaPut(b); continue; }
        await new Promise(r => setTimeout(r, 500));
      }
      await refresh();
      render();
      showToast(`自动分析完成`);
    }

    // Hide loader
    setTimeout(() => loader.classList.add("done"), 500);
    setTimeout(() => loader.style.display = "none", 1000);
  }

  init();
})();

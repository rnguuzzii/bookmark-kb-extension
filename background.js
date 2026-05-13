/* ================================================================== */
/* Markbase Background Service Worker                                  */
/* ================================================================== */

const DB_NAME = "markbase_ext";
const DB_VERSION = 2;

/* ---------- IndexedDB ---------- */
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
      if (!db.objectStoreNames.contains("conversations")) {
        const conv = db.createObjectStore("conversations", { keyPath: "id" });
        conv.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msg = db.createObjectStore("messages", { keyPath: "id" });
        msg.createIndex("conversationId", "conversationId", { unique: false });
        msg.createIndex("timestamp", "timestamp", { unique: false });
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

function metaGet(id) {
  return openDB().then(db => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(id);
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

function metaGetAll() {
  return openDB().then(db => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").getAll();
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  });
}

/* ---------- Bookmark flatten ---------- */
function flattenTree(node) {
  const items = [];
  function walk(n) {
    if (n.url) items.push({ id: n.id, title: n.title, url: n.url, dateAdded: n.dateAdded, parentId: n.parentId });
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return items;
}

async function getAllBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  return flattenTree(tree[0]);
}

/* ---------- Sync ---------- */
async function fullSync() {
  const bookmarks = await getAllBookmarks();
  const metas = await metaGetAll();
  const metaMap = new Map(metas.map(m => [m.bookmarkId, m]));

  let added = 0;
  for (const bm of bookmarks) {
    if (!metaMap.has(bm.id)) {
      await metaPut({
        bookmarkId: bm.id,
        url: bm.url,
        title: bm.title,
        category: "",
        tags: [],
        summary: "",
        notes: "",
        addedAt: bm.dateAdded || Date.now()
      });
      added++;
    }
  }

  // Remove orphaned (bookmark deleted from browser)
  const liveIds = new Set(bookmarks.map(b => b.id));
  for (const meta of metas) {
    if (!liveIds.has(meta.bookmarkId)) {
      await metaDelete(meta.bookmarkId);
    }
  }

  return { added, total: bookmarks.length };
}

/* ---------- Lifecycle ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  const result = await fullSync();
  console.log(`[Markbase] Initial sync: ${result.added} new, ${result.total} total`);

  // Right-click context menu
  chrome.contextMenus.create({
    id: "markbase-add",
    title: "添加到 Markbase 并分析",
    contexts: ["page", "link", "image"]
  });
});

chrome.runtime.onStartup.addListener(async () => {
  const result = await fullSync();
  console.log(`[Markbase] Startup sync: ${result.added} added`);
});

/* ---------- Bookmark Events ---------- */
chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!bookmark.url) return; // folder
  await metaPut({
    bookmarkId: id,
    url: bookmark.url,
    title: bookmark.title,
    category: "",
    tags: [],
    summary: "",
    notes: "",
    addedAt: bookmark.dateAdded || Date.now()
  });
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  if (removeInfo.node.url) {
    await metaDelete(id);
  }
  // If it's a folder, recursively delete children
  if (removeInfo.node.children) {
    const flat = flattenTree(removeInfo.node);
    for (const item of flat) {
      await metaDelete(item.id);
    }
  }
});

/* ---------- Message Handlers ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SYNC") {
    fullSync().then(result => sendResponse(result));
    return true; // async
  }
  if (msg.type === "GET_METAS") {
    metaGetAll().then(metas => sendResponse(metas));
    return true;
  }
  if (msg.type === "PUT_META") {
    metaPut(msg.record).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "ADD_BOOKMARK") {
    (async () => {
      try {
        const bm = await chrome.bookmarks.create({ title: msg.title, url: msg.url });
        await metaPut({ bookmarkId: bm.id, url: msg.url, title: msg.title, category: "", tags: [], summary: "", notes: "", addedAt: Date.now() });
        sendResponse({ ok: true, id: bm.id });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
});

/* ---------- Context Menu ---------- */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "markbase-add") {
    const url = info.pageUrl || info.linkUrl || info.srcUrl;
    const title = tab?.title || url;
    if (!url) return;
    try {
      const bm = await chrome.bookmarks.create({ title, url });
      await metaPut({ bookmarkId: bm.id, url, title, category: "", tags: [], summary: "", notes: "", addedAt: Date.now() });
      // Open dashboard to show result
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    } catch (e) { console.error("[Markbase] Add failed:", e); }
  }
});

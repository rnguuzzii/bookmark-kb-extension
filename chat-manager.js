/* ================================================================== */
/* Markbase Chat Manager — floating AI assistant                        */
/* ================================================================== */

const ChatManager = (() => {
  /* ---------- IndexedDB (shared) ---------- */
  const DB_NAME = "markbase_ext";
  const DB_VERSION = 2;

  function openChatDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
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

  async function getConversations() {
    const db = await openChatDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("conversations", "readonly");
      const req = tx.objectStore("conversations").getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.updatedAt - a.updatedAt));
      req.onerror = () => reject(req.error);
    });
  }

  async function saveConversation(conv) {
    const db = await openChatDB();
    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").put(conv);
    return new Promise(r => { tx.oncomplete = r; });
  }

  async function deleteConversation(id) {
    const db = await openChatDB();
    // Delete messages
    const tx1 = db.transaction("messages", "readwrite");
    const msgStore = tx1.objectStore("messages");
    const idx = msgStore.index("conversationId");
    const keys = await new Promise((resolve) => { const req = idx.getAllKeys(); req.onsuccess = () => resolve(req.result); });
    for (const k of keys) msgStore.delete(k);
    await new Promise(r => { tx1.oncomplete = r; });
    // Delete conversation
    const tx2 = db.transaction("conversations", "readwrite");
    tx2.objectStore("conversations").delete(id);
    await new Promise(r => { tx2.oncomplete = r; });
  }

  async function getMessages(convId) {
    const db = await openChatDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("messages", "readonly");
      const req = tx.objectStore("messages").index("conversationId").getAll(convId);
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
      req.onerror = () => reject(req.error);
    });
  }

  async function saveMessage(msg) {
    const db = await openChatDB();
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(msg);
    return new Promise(r => { tx.oncomplete = r; });
  }

  /* ---------- System Context (dynamic, with current UI state) ---------- */
  async function getSystemContext() {
    // Collect current UI state if dashboard is open
    let uiState = {};
    try {
      const catEl = document.querySelector(".category-item.active");
      const tagEl = document.querySelector(".tag-item.active");
      const searchEl = document.getElementById("searchInput");
      uiState.activeCategory = catEl ? catEl.dataset.category : "all";
      uiState.activeTag = tagEl ? tagEl.dataset.tag : null;
      uiState.searchQuery = searchEl ? searchEl.value.trim() : "";

      // Grab visible bookmark cards from the DOM
      const cards = document.querySelectorAll(".bm-card");
      const visible = [];
      cards.forEach(c => {
        const title = c.querySelector(".bm-title a")?.textContent?.trim();
        if (title) visible.push({ title, url: "", category: "", tags: [], summary: "" });
      });
      uiState.visibleBookmarks = visible.slice(0, 15);
    } catch (e) { /* ignore */ }
    return LLM.buildDynamicContext(uiState);
  }

  /* ---------- UI State ---------- */
  let currentConvId = null;
  let convs = [];
  let messages = [];
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let pendingImages = []; // base64 images waiting to be sent

  /* ---------- DOM ---------- */
  let chatContainer, chatMessages, chatInput, chatSendBtn, chatImageBtn, chatModelSelect;
  let chatConvList, chatTitle, chatMinBtn, chatCloseBtn, chatFab, chatNewBtn;

  /* ---------- Init ---------- */
  async function init(container) {
    chatContainer = container;
    // DOM is already in dashboard.html, just grab refs
    chatMessages = chatContainer.querySelector(".chat-messages");
    chatInput = chatContainer.querySelector(".chat-input");
    chatSendBtn = chatContainer.querySelector(".chat-send");
    chatImageBtn = chatContainer.querySelector(".chat-image-btn");
    chatModelSelect = chatContainer.querySelector(".chat-model-select");
    chatConvList = chatContainer.querySelector(".chat-conv-list");
    chatTitle = chatContainer.querySelector(".chat-title");
    chatMinBtn = chatContainer.querySelector(".chat-minimize");
    chatCloseBtn = chatContainer.querySelector(".chat-close");
    chatFab = document.getElementById("chatFab");
    chatNewBtn = chatContainer.querySelector(".chat-new");

    // Populate model dropdown dynamically
    await populateModelSelect();

    bindEvents();
    loadConversations();
  }

  async function populateModelSelect() {
    if (!chatModelSelect) return;
    const providers = await LLM.getAvailableProviders(false);
    const currentVal = chatModelSelect.value;
    chatModelSelect.innerHTML = providers.map(p =>
      `<option value="${p.value}" ${!p.hasVision ? 'data-no-vision="1"' : ''}>${p.label}</option>`
    ).join("");
    if (providers.find(p => p.value === currentVal)) chatModelSelect.value = currentVal;
  }

  /* ---------- Event Binding ---------- */
  function bindEvents() {
    // Send
    chatSendBtn.addEventListener("click", handleSend);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    // Image upload
    chatImageBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.addEventListener("change", () => {
        for (const file of input.files) handleImageFile(file);
      });
      input.click();
    });

    // Paste images
    document.addEventListener("paste", (e) => {
      if (!chatContainer.classList.contains("open")) return;
      if (!chatInput.contains(document.activeElement) && document.activeElement !== chatInput) return;
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith("image/")) {
          handleImageFile(item.getAsFile());
        }
      }
    });

    // Drop images on chat
    chatContainer.addEventListener("dragover", (e) => { e.preventDefault(); });
    chatContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith("image/")) handleImageFile(file);
      }
    });

    // Model switch
    chatModelSelect.addEventListener("change", async () => {
      if (currentConvId) {
        const conv = convs.find(c => c.id === currentConvId);
        if (conv) { conv.modelProvider = chatModelSelect.value; await saveConversation(conv); }
      }
    });

    // Minimize / Close / New / FAB
    chatMinBtn.addEventListener("click", toggleMinimize);
    chatCloseBtn.addEventListener("click", close);
    chatFab.addEventListener("click", open);
    chatNewBtn.addEventListener("click", newConversation);

    // Dragging
    const header = chatContainer.querySelector(".chat-header");
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      isDragging = true;
      const rect = chatContainer.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      chatContainer.style.transition = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - chatContainer.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - chatContainer.offsetHeight));
      chatContainer.style.left = x + "px";
      chatContainer.style.top = y + "px";
      chatContainer.style.right = "auto";
      chatContainer.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => { isDragging = false; chatContainer.style.transition = ""; });
  }

  /* ---------= Image Handling ---------- */
  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const compressed = await LLM.compressImage(e.target.result);
      pendingImages.push(compressed);
      // Show preview
      const preview = document.createElement("div");
      preview.className = "chat-image-preview";
      preview.innerHTML = `<img src="${compressed}" alt=""><button class="chat-img-remove">&times;</button>`;
      preview.querySelector("button").addEventListener("click", () => {
        pendingImages = pendingImages.filter(p => p !== compressed);
        preview.remove();
      });
      chatInput.parentElement.insertBefore(preview, chatInput.parentElement.firstChild);
      // Auto-switch to vision-capable provider
      if (!LLM.supportsVision(chatModelSelect.value)) {
        const visionProvider = (await LLM.getAvailableProviders(true))[0];
        if (visionProvider) {
          chatModelSelect.value = visionProvider.value;
          chatModelSelect.style.borderColor = "var(--accent)";
          // Update conversation
          if (currentConvId) {
            const conv = convs.find(c => c.id === currentConvId);
            if (conv) { conv.modelProvider = visionProvider.value; await saveConversation(conv); }
          }
        }
      }
    };
    reader.readAsDataURL(file);
  }

  /* ---------- Send Message ---------- */
  async function handleSend() {
    const text = chatInput.value.trim();
    if (!text && pendingImages.length === 0) return;
    if (!currentConvId) await newConversation();

    // Ensure LLM settings are fresh
    await LLM.loadSettings();
    chatInput.value = "";

    // Snapshot images BEFORE building content (will clear later)
    const snapshotImages = [...pendingImages];

    // Build user content
    let content;
    if (snapshotImages.length > 0) {
      content = [{ type: "text", text: text || "描述这张图片" }];
      for (const img of snapshotImages) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
    } else {
      content = text;
    }

    const userMsg = {
      id: uid(),
      conversationId: currentConvId,
      role: "user",
      content,
      timestamp: Date.now()
    };

    // Attach images for rendering
    if (snapshotImages.length > 0) {
      userMsg._images = [...snapshotImages];
    }

    await saveMessage(userMsg);
    messages.push(userMsg);

    // NOW clear pending images (after content is fully built and saved)
    pendingImages = [];
    clearImagePreviews();

    renderMessages();
    scrollToBottom();

    // Update conversation
    const conv = convs.find(c => c.id === currentConvId);
    if (conv) {
      conv.updatedAt = Date.now();
      if (!conv.title || conv.title === "新对话") {
        conv.title = (typeof content === "string" ? content : text || "图片对话").slice(0, 30);
      }
      await saveConversation(conv);
      renderConvList();
    }

    // Call LLM
    const provider = chatModelSelect.value;
    const systemPrompt = await getSystemContext();

    // Determine if vision needed (use snapshot and content array)
    const hasImgs = Array.isArray(userMsg.content) && LLM.hasImage(userMsg.content);

    if (hasImgs) {
      // Vision call — extract image URLs from user message
      const imgs = userMsg.content
        .filter(p => p.type === "image_url")
        .map(p => p.image_url.url);

      await LLM.visionChat({
        provider,
        text: text || "描述这张图片",
        images: imgs,
        systemPrompt,
        onDone: async (reply) => {
          const aiMsg = { id: uid(), conversationId: currentConvId, role: "assistant", content: reply, timestamp: Date.now() };
          await saveMessage(aiMsg);
          messages.push(aiMsg);
          renderMessages();
          scrollToBottom();
        },
        onError: async (err) => {
          const errMsg = { id: uid(), conversationId: currentConvId, role: "assistant", content: `错误: ${err.message}`, timestamp: Date.now() };
          await saveMessage(errMsg);
          messages.push(errMsg);
          renderMessages();
          scrollToBottom();
        }
      });
    } else {
      // Text streaming
      const aiMsg = { id: uid(), conversationId: currentConvId, role: "assistant", content: "", timestamp: Date.now() };
      messages.push(aiMsg);
      renderMessages();
      const aiEl = chatMessages.querySelector(`[data-msg-id="${aiMsg.id}"] .chat-bubble-text`);

      // Strip image_url content from history if model doesn't support vision
      const historyMsgs = messages.filter(m => m.id !== aiMsg.id).map(m => {
        let c = m.content;
        if (!LLM.supportsVision(provider) && Array.isArray(c)) {
          c = c.filter(p => p.type !== "image_url").map(p => p.type === "text" ? p.text : "").join(" ").trim() || "(图片)";
        }
        return { role: m.role, content: c };
      });

      await LLM.chatStream({
        provider,
        systemPrompt,
        messages: historyMsgs,
        onToken: (token, full) => {
          aiMsg.content = full;
          if (aiEl) { aiEl.innerHTML = renderMarkdown(full); scrollToBottom(); }
        },
        onDone: async (full) => {
          aiMsg.content = full;
          await saveMessage(aiMsg);
          if (aiEl) aiEl.innerHTML = renderMarkdown(full);
        },
        onError: async (err) => {
          aiMsg.content = `错误: ${err.message}`;
          await saveMessage(aiMsg);
          if (aiEl) aiEl.textContent = aiMsg.content;
        }
      });
    }
  }

  function clearImagePreviews() {
    chatContainer.querySelectorAll(".chat-image-preview").forEach(el => el.remove());
  }

  /* ---------- Conversation Management ---------- */
  async function loadConversations() {
    convs = await getConversations();
    renderConvList();
    if (convs.length > 0) {
      switchConversation(convs[0].id);
    } else {
      await newConversation(true);
    }
  }

  async function newConversation(silent = false) {
    const provider = chatModelSelect ? chatModelSelect.value : "deepseek";
    const conv = {
      id: uid(),
      title: "新对话",
      modelProvider: provider,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await saveConversation(conv);
    convs.unshift(conv);
    renderConvList();
    switchConversation(conv.id);
    if (!silent) open();
  }

  async function switchConversation(id) {
    currentConvId = id;
    messages = await getMessages(id);
    const conv = convs.find(c => c.id === id);
    if (conv) {
      chatTitle.textContent = conv.title || "新对话";
      chatModelSelect.value = conv.modelProvider || "deepseek";
    }
    renderMessages();
    scrollToBottom();
    renderConvList();
  }

  async function deleteCurrentConv() {
    if (!currentConvId) return;
    if (!confirm("删除当前对话？")) return;
    await deleteConversation(currentConvId);
    convs = convs.filter(c => c.id !== currentConvId);
    currentConvId = null;
    messages = [];
    if (convs.length > 0) {
      switchConversation(convs[0].id);
    } else {
      await newConversation(true);
    }
    renderConvList();
    renderMessages();
  }

  /* ---------- Rendering ---------- */
  function renderConvList() {
    if (!chatConvList) return;
    chatConvList.innerHTML = convs.slice(0, 20).map(c => `
      <div class="chat-conv-item ${c.id === currentConvId ? 'active' : ''}" data-conv-id="${c.id}">
        <span class="chat-conv-name">${esc(c.title || "新对话")}</span>
        <button class="chat-conv-del" data-del-conv="${c.id}" title="删除">&times;</button>
      </div>
    `).join("");

    // Bind events
    chatConvList.querySelectorAll(".chat-conv-item").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".chat-conv-del")) return;
        switchConversation(el.dataset.convId);
      });
    });
    chatConvList.querySelectorAll(".chat-conv-del").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.delConv;
        if (confirm("删除对话？")) {
          deleteConversation(id);
          convs = convs.filter(c => c.id !== id);
          if (currentConvId === id) {
            currentConvId = null; messages = [];
            if (convs.length > 0) switchConversation(convs[0].id);
            else newConversation(true);
          }
          renderConvList();
          renderMessages();
        }
      });
    });
  }

  function renderMessages() {
    if (!chatMessages) return;
    let html = "";
    for (const m of messages) {
      const isUser = m.role === "user";
      html += `<div class="chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-ai'}" data-msg-id="${m.id}">`;
      if (!isUser) html += `<div class="chat-avatar">AI</div>`;
      html += `<div class="chat-bubble"><div class="chat-bubble-text">`;

      if (isUser) {
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === "image_url") {
              html += `<img src="${part.image_url.url}" class="chat-msg-img" alt="">`;
            } else if (part.type === "text") {
              html += `<p>${esc(part.text)}</p>`;
            }
          }
        } else {
          html += `<p>${esc(m.content)}</p>`;
        }
        // Also render any _images
        if (m._images) {
          for (const img of m._images) {
            html += `<img src="${img}" class="chat-msg-img" alt="">`;
          }
        }
      } else {
        html += renderMarkdown(m.content);
      }

      html += `</div><div class="chat-msg-time">${timeFmt(m.timestamp)}</div></div>`;
      if (isUser) html += `<div class="chat-avatar chat-avatar-user">U</div>`;
      // Copy button for AI messages
      if (!isUser && m.content) {
        html += `<button class="chat-copy-btn" data-copy="${esc(m.content).replace(/"/g, '&quot;')}" title="复制">&copy2;</button>`;
      }
      html += `</div>`;
    }
    chatMessages.innerHTML = html;
    scrollToBottom();

    // Bind copy buttons
    chatMessages.querySelectorAll(".chat-copy-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = "✓";
          setTimeout(() => btn.textContent = "©2", 1200);
        });
      });
    });

    // Highlight code blocks
    chatMessages.querySelectorAll("pre code").forEach(block => {
      block.innerHTML = block.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    });
  }

  function scrollToBottom() {
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  /* ---------- Simple markdown renderer ---------- */
  function renderMarkdown(text) {
    if (!text) return "";
    let html = esc(text);
    // Code blocks ```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
    // Inline code `
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold **
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic *
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Newlines
    html = html.replace(/\n/g, "<br>");
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    // Bullet lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    return html;
  }

  /* ---------- Open / Close / Minimize ---------- */
  function open() {
    chatContainer.classList.add("open");
    chatFab.style.display = "none";
    if (isMinimized) toggleMinimize();
  }

  function close() {
    chatContainer.classList.remove("open");
    chatFab.style.display = "";
  }

  function toggleMinimize() {
    isMinimized = !isMinimized;
    chatContainer.classList.toggle("minimized", isMinimized);
  }

  /* ---------- Helpers ---------- */
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function esc(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
  function timeFmt(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  }

  async function refreshModels() {
    await populateModelSelect();
  }

  return { init, open, close, refreshModels };
})();

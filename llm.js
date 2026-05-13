/* ================================================================== */
/* Markbase LLM Layer — unified multi-provider chat + vision + dynamic  */
/* ================================================================== */

const LLM = (() => {
  const DEFAULT_SETTINGS = {
    provider: "deepseek",
    dsKey: "", dsEndpoint: "https://api.deepseek.com/v1/chat/completions", dsModel: "deepseek-chat",
    qwenKey: "", qwenEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", qwenModel: "qwen-turbo", qwenVisionModel: "qwen-vl-plus",
    doubaoKey: "", doubaoEndpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", doubaoModel: "doubao-pro-32k", doubaoVisionModel: "doubao-1-5-vision-pro-32k",
    customName: "", customKey: "", customEndpoint: "", customModel: "", customVisionModel: "",
    chatProvider: "deepseek", visionProvider: "qwen", analysisProvider: "deepseek"
  };

  let settings = { ...DEFAULT_SETTINGS };

  async function loadSettings() {
    const data = await chrome.storage.local.get("api");
    settings = data.api ? { ...DEFAULT_SETTINGS, ...data.api } : { ...DEFAULT_SETTINGS };
  }

  function getProviderConfig(provider) {
    if (provider === "deepseek") return { key: settings.dsKey, endpoint: settings.dsEndpoint, model: settings.dsModel };
    if (provider === "qwen") return { key: settings.qwenKey, endpoint: settings.qwenEndpoint, model: settings.qwenModel };
    if (provider === "doubao") return { key: settings.doubaoKey, endpoint: settings.doubaoEndpoint, model: settings.doubaoModel };
    if (provider === "custom") return { key: settings.customKey, endpoint: settings.customEndpoint, model: settings.customModel || "gpt-3.5-turbo" };
    // Fallback: treat as provider name from task routing
    return { key: "", endpoint: "", model: "" };
  }

  function getVisionConfig(provider) {
    if (provider === "qwen") return { key: settings.qwenKey, endpoint: settings.qwenEndpoint, model: settings.qwenVisionModel || "qwen-vl-plus" };
    if (provider === "doubao") return { key: settings.doubaoKey, endpoint: settings.doubaoEndpoint, model: settings.doubaoVisionModel || "doubao-1-5-vision-pro-32k" };
    if (provider === "custom") return { key: settings.customKey, endpoint: settings.customEndpoint, model: settings.customVisionModel || settings.customModel || "gpt-4o" };
    return { key: "", endpoint: "", model: "" };
  }

  /* ---------- Provider name for display ---------- */
  function getProviderDisplayName(provider) {
    if (provider === "deepseek") return "DeepSeek";
    if (provider === "qwen") return "通义千问";
    if (provider === "doubao") return "豆包";
    if (provider === "custom") return settings.customName || "自定义";
    return provider;
  }

  /* ---------- Check if provider supports vision ---------- */
  function supportsVision(provider) {
    if (provider === "deepseek") return false;
    if (provider === "qwen" && settings.qwenVisionModel) return true;
    if (provider === "doubao" && settings.doubaoVisionModel) return true;
    if (provider === "custom" && (settings.customVisionModel || settings.customModel)) return true;
    return provider !== "deepseek";
  }

  /* ---------- Dynamic system context ---------- */
  async function buildDynamicContext(uiState = {}) {
    await loadSettings();
    let metas = [];
    let bookmarkCount = 0;
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("markbase_ext", 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      metas = await new Promise((resolve) => {
        const tx = db.transaction("meta", "readonly");
        const r = tx.objectStore("meta").getAll();
        r.onsuccess = () => resolve(r.result);
      });
      const tree = await chrome.bookmarks.getTree();
      bookmarkCount = flattenTree(tree[0]).length;
    } catch (e) { /* use defaults */ }

    const tagged = metas.filter(m => m.summary).length;
    const catMap = {};
    const tagMap = {};
    for (const m of metas) {
      if (m.category && m.category !== "未分类") catMap[m.category] = (catMap[m.category] || 0) + 1;
      if (m.tags) for (const t of m.tags) tagMap[t] = (tagMap[t] || 0) + 1;
    }
    const topCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n}(${c})`).join("、");
    const topTags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([n, c]) => `${n}(${c})`).join("、");

    // Build current view context
    let currentView = "";
    if (uiState.activeCategory && uiState.activeCategory !== "all") {
      currentView += `用户当前筛选分类：${uiState.activeCategory}\n`;
    }
    if (uiState.activeTag) {
      currentView += `用户当前筛选标签：${uiState.activeTag}\n`;
    }
    if (uiState.searchQuery) {
      currentView += `用户当前搜索：${uiState.searchQuery}\n`;
    }

    // Include visible bookmarks (up to 15) with full details
    if (uiState.visibleBookmarks && uiState.visibleBookmarks.length > 0) {
      currentView += "\n当前可见书签（部分）：\n";
      for (const b of uiState.visibleBookmarks.slice(0, 15)) {
        currentView += `- [${escCtx(b.title)}](${b.url}) | 分类:${b.category || "无"} | 标签:${(b.tags || []).join(",") || "无"} | 摘要:${b.summary || "无"}\n`;
      }
    }

    return `你是 DeepSeek，同时连接了用户 Markbase 书签数据库。你可以回答任何问题，不限于书签。

## 书签数据库（实时）
- 总数：${bookmarkCount} 条 | 已分析：${tagged} 条
- 分类：${topCats || "无"}
- 标签：${topTags || "无"}
${currentView ? "\n## 用户当前在看\n" + currentView : ""}

## Markbase 参考
- 书签元数据字段：bookmarkId, url, title, summary, category, tags[], notes, addedAt
- 界面：左侧分类/标签筛选 | Ctrl+K 搜索 | 「AI 批处理」按钮 | 「深度重新分析」按钮

## 回答风格
- 书签相关问题 → 引用上面已有的分类名/标签名，精准回答
- 其他问题 → 正常回答，不拒绝。如果和书签无关，可在句首轻提醒一句"我不是专门做这个的，但……"
- 始终用中文`;
  }

  function escCtx(s) { return (s || "").replace(/[\\$'"]/g, "").slice(0, 200); }

  function flattenTree(node) {
    const items = [];
    function walk(n) { if (n.url) items.push(n); if (n.children) n.children.forEach(walk); }
    walk(node);
    return items;
  }

  /* ---------- Image compression ---------- */
  async function compressImage(dataUrl, maxDim = 1024, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => { img.src = ""; reject(new Error("image load timeout")); }, 7000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          let w = img.width, h = img.height;
          if (w <= maxDim && h <= maxDim) { resolve(dataUrl); return; }
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) { resolve(dataUrl); } // tainted canvas fallback
      };
      img.onerror = () => { clearTimeout(timer); reject(new Error("image load failed")); };
      img.crossOrigin = "anonymous";
      img.src = dataUrl;
    });
  }

  /* ---------- Chat Stream ---------- */
  async function chatStream({ provider, model, systemPrompt, messages, onToken, onDone, onError }) {
    await loadSettings();
    const cfg = getProviderConfig(provider);
    if (!cfg.key) { onError && onError(new Error(`请先设置 ${getProviderDisplayName(provider)} 的 API Key`)); return; }

    const body = JSON.stringify({
      model: model || cfg.model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.5, max_tokens: 2048, stream: true
    });

    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
        body
      });
      if (!res.ok) { const text = await res.text(); throw new Error(`API ${res.status}: ${text.slice(0, 300)}`); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "", buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data: ")) continue;
          const data = s.slice(6);
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) { full += delta; onToken && onToken(delta, full); }
          } catch (e) { /* skip */ }
        }
      }
      onDone && onDone(full);
    } catch (err) { onError && onError(err); }
  }

  /* ---------- Vision Chat ---------- */
  async function visionChat({ provider, model, systemPrompt, text, images, onDone, onError }) {
    await loadSettings();
    if (provider === "deepseek") provider = settings.visionProvider || "qwen"; // DS no vision
    if (!supportsVision(provider)) { onError && onError(new Error(`${getProviderDisplayName(provider)} 不支持视觉，请在设置中配置视觉模型`)); return; }
    const cfg = getVisionConfig(provider);
    if (!cfg.key) { onError && onError(new Error(`请先设置 ${getProviderDisplayName(provider)} 的 API Key 和 Vision Model`)); return; }

    const compressed = (await Promise.allSettled(images.map(img => compressImage(img))))
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value);
    if (compressed.length === 0) { onError && onError(new Error("图片加载失败，已跳过")); return; }
    const userContent = [];
    for (const img of compressed) userContent.push({ type: "image_url", image_url: { url: img } });
    if (text) userContent.push({ type: "text", text });

    const body = JSON.stringify({
      model: model || cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      temperature: 0.3, max_tokens: 1500
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) { const txt = await res.text(); throw new Error(`Vision API ${res.status}: ${txt.slice(0, 300)}`); }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      onDone && onDone(content);
    } catch (err) {
      clearTimeout(timer);
      onError && onError(err.name === "AbortError" ? new Error("视觉分析超时，已跳过") : err);
    }
  }

  /* ---------- Text call (non-streaming, JSON output) ---------- */
  async function textCall({ provider, systemPrompt, userPrompt, temperature = 0.3 }) {
    await loadSettings();
    const cfg = getProviderConfig(provider);
    if (!cfg.key) throw new Error(`请先设置 ${getProviderDisplayName(provider)} 的 API Key`);

    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt || "Always respond with valid JSON only, no markdown." },
          { role: "user", content: userPrompt }
        ],
        temperature, max_tokens: 500
      })
    });
    if (!res.ok) { const text = await res.text(); throw new Error(`API ${res.status}: ${text.slice(0, 300)}`); }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const jsonStr = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    return JSON.parse(jsonStr);
  }

  function hasImage(content) {
    if (Array.isArray(content)) return content.some(p => p.type === "image_url" || p.image_url);
    return false;
  }

  /* ---------- Fetch page content ---------- */
  async function fetchPageContent(url) {
    const result = { text: "", images: [], error: null };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      clearTimeout(timer);
      if (!res.ok) { result.error = `HTTP ${res.status}`; return result; }

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      // ---- Extract text ----
      const title = doc.querySelector("title")?.textContent?.trim() || "";
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "";
      const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || "";

      // Main content area
      const main = doc.querySelector("article, main, [role='main'], #content, .content, .post, .article");
      // Clean: remove nav, footer, script, style, aside, header
      const cleanDoc = main || doc.body;
      if (cleanDoc) {
        cleanDoc.querySelectorAll("script, style, nav, footer, aside, header, .sidebar, .nav, .footer, .ad, .advertisement, .menu, noscript").forEach(el => el.remove());
      }
      const bodyText = (cleanDoc || doc.body)?.textContent?.replace(/\s+/g, " ").trim() || "";

      // Build structured text
      let text = title ? `标题：${title}\n` : "";
      text += metaDesc ? `简介：${metaDesc}\n` : ogDesc ? `简介：${ogDesc}\n` : "";
      // Get headings
      const headings = doc.querySelectorAll("h1, h2, h3");
      if (headings.length > 0) {
        text += "页面结构：\n";
        headings.forEach((h, i) => { if (i < 8) text += `  ${h.tagName}: ${h.textContent.trim()}\n`; });
      }
      // Truncated body
      const truncated = bodyText.slice(0, 2000);
      text += `正文摘要：${truncated}${bodyText.length > 2000 ? "（截断）" : ""}`;

      result.text = text.slice(0, 3000);

      // ---- Extract key images ----
      const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
      if (ogImage) {
        const imgUrl = new URL(ogImage, url).href;
        result.images.push({ url: imgUrl, source: "og:image" });
      }

      // Find largest images in content area
      const imgs = (main || doc).querySelectorAll("img[src]");
      const candidates = [];
      for (const img of imgs) {
        const src = img.getAttribute("src") || "";
        if (!src || src.includes("data:image/svg") || src.includes("icon") || src.includes("logo") || src.includes("avatar")) continue;
        const w = parseInt(img.getAttribute("width") || img.naturalWidth || "0");
        const h = parseInt(img.getAttribute("height") || img.naturalHeight || "0");
        const area = w * h || 10000; // default assume decent size
        candidates.push({ url: new URL(src, url).href, area });
      }
      candidates.sort((a, b) => b.area - a.area);
      // Take top 2 (excluding duplicate of og:image)
      for (const c of candidates) {
        if (result.images.length >= 3) break;
        if (!result.images.some(i => i.url === c.url)) {
          result.images.push({ url: c.url, source: "content" });
        }
      }
    } catch (err) {
      result.error = err.name === "AbortError" ? "超时" : err.message;
    }
    return result;
  }

  /* ---------- Deep analyze bookmark ---------- */
  async function deepAnalyze({ url, title, onProgress }) {
    await loadSettings();
    const analysisProvider = settings.analysisProvider || "deepseek";
    const visionProvider = settings.visionProvider || "qwen";

    // Step 1: fetch page content
    onProgress && onProgress("抓取页面内容...");
    const page = await fetchPageContent(url);
    if (page.error && !page.text) {
      // Fallback: just use URL + title
      onProgress && onProgress("页面抓取失败，降级为标题分析...");
    }

    // Step 2: text analysis
    onProgress && onProgress("AI 文本分析...");
    const textPrompt = `深入分析以下网页，给出丰富的标签。返回 JSON：

{
  "summary": "一句中文概括这个页面到底讲什么（30字内）",
  "category": "分类：前端/后端/设计/AI/机器学习/工具/效率/阅读/视频/产品/安全/社区/文档/教程/开源/商业/游戏/数据科学/DevOps/移动开发/其他",
  "tags": ["详细标签1", "详细标签2", ...]
}

标签要求（至少5个，最多15个）：
- 覆盖技术栈（如：React, Python, Docker, TypeScript, Rust）
- 覆盖内容类型（如：教程, API文档, 博客, 工具, 开源项目, 视频课程, 新闻）
- 覆盖应用场景（如：自动化, 监控, 测试, 部署, 安全, 性能优化）
- 覆盖关键词（如：Hooks, 微服务, LLM, 向量数据库, RAG）

URL: ${url}
${page.text || `标题：${title}`}

只返回 JSON，不要其他文字。`;

    const textResult = await textCall({
      provider: analysisProvider,
      systemPrompt: "Always respond with valid JSON only, no markdown, no extra text.",
      userPrompt: textPrompt
    });

    // Step 3: vision analysis (if images found, with hard 20s timeout per bookmark)
    let visionInsight = "";
    if (page.images.length > 0 && supportsVision(visionProvider)) {
      try {
        onProgress && onProgress(`图片分析 (${page.images.length} 张)...`);
        const imgs = page.images.slice(0, 2).map(i => i.url);
        // Race vision against a hard deadline
        const visionDone = new Promise((resolve) => {
          visionChat({
            provider: visionProvider,
            text: `这个网页的标题是"${title}"，URL 是 ${url}。请根据这张图片补充理解：这个网页主要关于什么？用一句话中文描述（20字内）。只返回描述，不要多余内容。`,
            images: imgs,
            onDone: (reply) => { visionInsight = reply.trim(); resolve(); },
            onError: () => resolve()
          });
        });
        const deadline = new Promise(r => setTimeout(() => { console.log("Vision timeout, skipping"); r(); }, 20000));
        await Promise.race([visionDone, deadline]);
      } catch (e) { /* vision failed, skip */ }
    }

    // Merge results
    const finalSummary = textResult.summary || (visionInsight || title).slice(0, 30);
    const finalCategory = textResult.category || "其他";
    const finalTags = [...new Set([...(textResult.tags || []), ...(visionInsight ? [visionInsight.slice(0, 8)] : [])])].slice(0, 15);

    return {
      summary: finalSummary,
      category: finalCategory,
      tags: finalTags,
      hasPageContent: !!page.text,
      hasVision: !!visionInsight,
      pageImages: page.images.length
    };
  }

  /* ---------- Get providers list for dropdowns ---------- */
  async function getAvailableProviders(includeVision) {
    await loadSettings();
    const list = [
      { value: "deepseek", label: "DeepSeek", hasVision: false },
      { value: "qwen", label: "通义千问", hasVision: !!settings.qwenVisionModel },
      { value: "doubao", label: "豆包", hasVision: !!settings.doubaoVisionModel }
    ];
    if (settings.customKey) {
      list.push({
        value: "custom",
        label: settings.customName || "自定义",
        hasVision: !!(settings.customVisionModel || settings.customModel)
      });
    }
    if (includeVision) return list.filter(p => p.hasVision);
    return list;
  }

  return {
    loadSettings, getProviderConfig, getVisionConfig, getProviderDisplayName,
    supportsVision, buildDynamicContext, compressImage,
    chatStream, visionChat, textCall, hasImage, getAvailableProviders,
    fetchPageContent, deepAnalyze,
    DEFAULT_SETTINGS
  };
})();

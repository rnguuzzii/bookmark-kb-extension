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
  async function buildDynamicContext() {
    await loadSettings();
    // Read current metas and bookmarks from the shared IndexedDB
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
    const topCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => `${n}(${c})`).join("、");
    const topTags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n, c]) => `${n}(${c})`).join("、");

    return `你是 Markbase 的 AI 助理。Markbase 是一款 Chrome 浏览器书签管理扩展。

## 当前用户数据
- 浏览器书签总数：${bookmarkCount} 条
- 已 AI 分析：${tagged} 条
- 已有分类：${topCats || "无"}
- 常用标签：${topTags || "无"}

## Markbase 核心能力
- 自动同步浏览器书签（chrome.bookmarks API）
- 数据存储在本地 IndexedDB（meta store: bookmarkId, url, title, summary, category, tags, notes, addedAt）
- AI 自动摘要、分类、打标签
- 支持文本模型：DeepSeek、通义千问、豆包、自定义 OpenAI 兼容 API
- 支持视觉模型：通义千问 VL、豆包 Vision、自定义（DeepSeek 不支持视觉）

## 用户界面
- 左侧边栏：搜索框（Ctrl+K）、分类列表、标签云、操作按钮
- 主区域：书签卡片网格，支持搜索/筛选/排序
- 右上角「AI 批处理」遍历全部未分析书签
- 右下角蓝色 AI 悬浮窗（当前对话）
- 书签详情面板

## 常见问题解答
- 看不到书签：点左下角「同步书签」
- AI 分析失败：检查 API 设置中 Key 和模型名是否正确，确认视觉模型字段已填写
- 图片识别失败：确认在 API 设置中为通义千问/豆包填写了 Vision Model 字段
- 导入书签：浏览器书签自动同步，无需手动导入
- 自定义 API：在 API 设置 → 自定义 标签页填入任意 OpenAI 兼容接口

请用中文回复。要简洁实用，直接给出操作步骤。回答时可以引用具体的分类名和标签名。`;
  }

  function flattenTree(node) {
    const items = [];
    function walk(n) { if (n.url) items.push(n); if (n.children) n.children.forEach(walk); }
    walk(node);
    return items;
  }

  /* ---------- Image compression ---------- */
  async function compressImage(dataUrl, maxDim = 1024, quality = 0.85) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w <= maxDim && h <= maxDim) { resolve(dataUrl); return; }
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
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

    const compressed = await Promise.all(images.map(img => compressImage(img)));
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

    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
        body
      });
      if (!res.ok) { const txt = await res.text(); throw new Error(`Vision API ${res.status}: ${txt.slice(0, 300)}`); }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      onDone && onDone(content);
    } catch (err) { onError && onError(err); }
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
    const textPrompt = `分析以下网页并返回 JSON：
{
  "summary": "用一句简洁中文描述（30字内）",
  "category": "分类：前端/后端/设计/AI/工具/阅读/视频/产品/安全/社区/文档/其他",
  "tags": ["标签1", "标签2", "标签3"]
}

URL: ${url}
${page.text || `标题：${title}`}

只返回 JSON，不要其他文字。`;

    const textResult = await textCall({
      provider: analysisProvider,
      systemPrompt: "Always respond with valid JSON only, no markdown, no extra text.",
      userPrompt: textPrompt
    });

    // Step 3: vision analysis (if images found and vision available)
    let visionInsight = "";
    if (page.images.length > 0 && supportsVision(visionProvider)) {
      try {
        onProgress && onProgress(`图片分析 (${page.images.length} 张)...`);
        const imgs = page.images.slice(0, 2).map(i => i.url);
        // Use vision to get additional context
        await new Promise((resolve) => {
          visionChat({
            provider: visionProvider,
            text: `这个网页的标题是"${title}"，URL 是 ${url}。请根据这张图片补充理解：这个网页主要关于什么？用一句话中文描述（20字内）。只返回描述，不要多余内容。`,
            images: imgs,
            onDone: (reply) => { visionInsight = reply.trim(); resolve(); },
            onError: () => { resolve(); }
          });
        });
      } catch (e) { /* vision failed, skip */ }
    }

    // Merge results
    const finalSummary = textResult.summary || (visionInsight || title).slice(0, 30);
    const finalCategory = textResult.category || "其他";
    const finalTags = [...new Set([...(textResult.tags || []), ...(visionInsight ? [visionInsight.slice(0, 8)] : [])])].slice(0, 5);

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

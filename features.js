/* ================================================================== */
/* Markbase Features — scoring, smart folders, graph, reports, etc.     */
/* ================================================================== */

const Features = (() => {

  /* ---------- IndexedDB helpers ---------- */
  async function getMetas() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("markbase_ext", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new Promise((resolve) => {
      const tx = db.transaction("meta", "readonly");
      const r = tx.objectStore("meta").getAll();
      r.onsuccess = () => resolve(r.result);
    });
  }

  async function metaPut(record) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("markbase_ext", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(record);
    return new Promise(r => { tx.oncomplete = r; });
  }

  async function saveSettings(s) { await chrome.storage.local.set({ api: s }); }
  async function getSettings() {
    const data = await chrome.storage.local.get("api");
    return data.api || {};
  }

  function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

  /* ================================================================== */
  /* 1. Bookmark Scoring (batch LLM, uses existing summaries)             */
  /* ================================================================== */
  async function scoreBookmarks(onProgress, batchSize = 30, force = false) {
    const metas = await getMetas();
    const toScore = force
      ? metas.filter(m => m.summary) // re-score all
      : metas.filter(m => m.summary && (!m.score || m.score === 0));
    if (toScore.length === 0) return { done: 0, msg: "所有书签已评分，可强制重新评分" };

    let done = 0;
    let skipped = 0;
    for (let i = 0; i < toScore.length; i += batchSize) {
      const batch = toScore.slice(i, i + batchSize);
      const listText = batch.map(b => `ID:${b.bookmarkId} | 标题:${b.title?.slice(0,60)} | 分类:${b.category} | 标签:${(b.tags||[]).slice(0,6).join(",")} | 摘要:${b.summary?.slice(0,80)}`).join("\n---\n");

      onProgress && onProgress(`评分 ${Math.min(i+batchSize, toScore.length)}/${toScore.length}`);
      try {
        const s = await getSettings();
        const provider = s.analysisProvider || "deepseek";
        const result = await LLM.textCall({
          provider,
          systemPrompt: "你是专业的内容评审员。评分只看内容本身的质量、信息价值和原创性。禁止因主题（包括性、成人、政治等任何敏感话题）压低分数。性是每个人生活的正常部分，优质的性相关内容（教育、艺术、健康、娱乐）应与任何其他优质内容同标准评分。只有粗制滥造、欺骗性、纯猎奇无信息量的才给低分。Always respond with valid JSON array only, no markdown.",
          userPrompt: `对以下书签逐一评分(1-10)。评分标准：
- 9-10分：内容优质、原创性强、信息丰富（不论主题，包括性教育、性艺术、成人娱乐等）
- 6-8分：内容尚可、有一定参考价值
- 3-5分：质量一般、信息量低
- 1-2分：粗制滥造、纯噱头、欺骗性内容

返回 JSON 数组：
[{"id":"bookmarkId","score":8,"reason":"5字内理由"}]

${listText}

只返回JSON数组。`,
          temperature: 0.2
        });

        if (Array.isArray(result)) {
          for (const item of result) {
            const meta = metas.find(m => m.bookmarkId === item.id);
            if (meta) {
              meta.score = item.score || 5;
              meta.scoreReason = item.reason || "";
              await metaPut(meta);
              done++;
            }
          }
        }
      } catch (e) {
        // Retry one-by-one, don't fake scores
        for (const b of batch) {
          onProgress && onProgress(`重试单条 ${done + skipped + 1}/${toScore.length}`);
          try {
            const singleResult = await tryScoreSingle(b, metas);
            if (singleResult.success) { done++; }
            else { b.score = 0; b.scoreReason = "评分失败"; await metaPut(b); skipped++; }
          } catch (e2) { b.score = 0; b.scoreReason = "评分失败"; await metaPut(b); skipped++; }
          await new Promise(r => setTimeout(r, 200));
        }
      }
      await new Promise(r => setTimeout(r, 400));
    }
    let msg = `评分完成：${done} 条`;
    if (skipped > 0) msg += `，${skipped} 条失败（已标记，可稍后重试）`;
    return { done, msg };
  }

  async function tryScoreSingle(b, metas) {
    const s = await getSettings();
    const provider = s.analysisProvider || "deepseek";
    const result = await LLM.textCall({
      provider,
      systemPrompt: "你是专业内容评审员。评分只基于内容质量、信息价值和原创性，不因主题（包括性、成人、政治）压低分数。性是正常生活的一部分，优质性教育/艺术/娱乐与任何优质内容同标准。Always respond with valid JSON only, no markdown.",
      userPrompt: `评分(1-10)。标准：9-10内容优质原创丰富, 6-8尚可有价值, 3-5一般信息少, 1-2粗制滥造噱头。\nID:${b.bookmarkId}\n标题:${b.title?.slice(0,80)}\n分类:${b.category}\n标签:${(b.tags||[]).slice(0,8).join(",")}\n摘要:${b.summary?.slice(0,100)}\n\n返回JSON：{"id":"${b.bookmarkId}","score":8,"reason":"理由"}`,
      temperature: 0.2
    });
    if (result && result.id && typeof result.score === "number") {
      const meta = metas.find(m => m.bookmarkId === result.id);
      if (meta) { meta.score = result.score; meta.scoreReason = result.reason || ""; await metaPut(meta); return { success: true }; }
    }
    return { success: false };
  }

  /* ================================================================== */
  /* 2. Smart Folders (1 LLM call)                                       */
  /* ================================================================== */
  async function smartFolders(onProgress) {
    const metas = await getMetas();
    const categories = [...new Set(metas.map(m => m.category).filter(Boolean))];
    if (categories.length === 0) return { folders: [], msg: "暂无分类数据" };

    onProgress && onProgress("AI 智能分组中...");
    try {
      const s = await getSettings();
      const provider = s.chatProvider || "deepseek";
      const result = await LLM.textCall({
        provider,
        systemPrompt: "Always respond with valid JSON array only, no markdown.",
        userPrompt: `将以下分类归入智能文件夹。每个分类可归入多个文件夹。返回 JSON：
[{"folder":"值得细读","categories":["分类1","分类2"]},{"folder":"工具站","categories":[...]},{"folder":"学习资源","categories":[...]},{"folder":"资讯速览","categories":[...]},{"folder":"已过时","categories":[...]},{"folder":"开源项目","categories":[...]}]

已有分类：${categories.join("、")}

只返回JSON数组。`,
        temperature: 0.2
      });

      if (Array.isArray(result)) {
        // Apply smart folder tags
        for (const folder of result) {
          if (!folder.categories) continue;
          for (const cat of folder.categories) {
            for (const meta of metas) {
              if (meta.category === cat) {
                meta.smartFolder = meta.smartFolder || [];
                if (!meta.smartFolder.includes(folder.folder)) {
                  meta.smartFolder.push(folder.folder);
                  await metaPut(meta);
                }
              }
            }
          }
        }
        return { folders: result, msg: `已分组到 ${result.length} 个智能文件夹` };
      }
    } catch (e) {
      // Fallback with simple rules
      const rules = {
        "值得细读": ["阅读","AI","产品","安全","数据科学"],
        "工具站": ["工具","效率","DevOps"],
        "学习资源": ["教程","文档","前端","后端","移动开发","机器学习"],
        "开源项目": ["开源","社区"],
        "资讯速览": ["视频","新闻"]
      };
      for (const [folder, keywords] of Object.entries(rules)) {
        for (const meta of metas) {
          const text = `${meta.category||""} ${(meta.tags||[]).join(" ")}`.toLowerCase();
          if (keywords.some(k => text.includes(k.toLowerCase()))) {
            meta.smartFolder = meta.smartFolder || [];
            if (!meta.smartFolder.includes(folder)) { meta.smartFolder.push(folder); await metaPut(meta); }
          }
        }
      }
      return { folders: Object.keys(rules).map(f => ({ folder: f, categories: rules[f] })), msg: "已用默认规则分组（API不可用）" };
    }
  }

  /* ================================================================== */
  /* 3. Relationship Graph (Canvas force-directed, tag co-occurrence)     */
  /* ================================================================== */
  function renderGraph(canvas, metas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width = canvas.parentElement.clientWidth;
    const H = canvas.height = Math.min(600, canvas.parentElement.clientHeight);

    // Build tag co-occurrence graph
    const tagMap = {};
    const edges = {};
    for (const m of metas) {
      if (!m.tags || m.tags.length === 0) continue;
      for (const t of m.tags) tagMap[t] = (tagMap[t] || 0) + 1;
      for (let i = 0; i < m.tags.length; i++) {
        for (let j = i + 1; j < m.tags.length; j++) {
          const key = [m.tags[i], m.tags[j]].sort().join("|||");
          edges[key] = (edges[key] || 0) + 1;
        }
      }
    }

    // Take top tags by count
    const nodes = Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([name, count]) => ({
        name,
        count,
        x: W/2 + Math.random() * 100 - 50,
        y: H/2 + Math.random() * 100 - 50,
        vx: 0, vy: 0
      }));

    const nodeMap = new Map(nodes.map(n => [n.name, n]));
    const links = [];
    for (const [key, weight] of Object.entries(edges)) {
      const [a, b] = key.split("|||");
      const na = nodeMap.get(a), nb = nodeMap.get(b);
      if (na && nb) links.push({ source: na, target: nb, weight });
    }

    // Force simulation
    function simulate(iterations = 80) {
      for (let iter = 0; iter < iterations; iter++) {
        const alpha = 1 - iter / iterations;
        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.max(1, Math.hypot(dx, dy));
            const force = 300 * alpha / (dist * dist);
            const fx = dx / dist * force, fy = dy / dist * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }
        // Attraction
        for (const l of links) {
          const a = l.source, b = l.target;
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const force = l.weight * 0.003 * alpha * dist;
          const fx = dx / dist * force, fy = dy / dist * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
        // Center gravity
        for (const n of nodes) {
          n.vx += (W/2 - n.x) * 0.001 * alpha;
          n.vy += (H/2 - n.y) * 0.001 * alpha;
          n.x += n.vx * 0.5; n.y += n.vy * 0.5;
          n.vx *= 0.6; n.vy *= 0.6;
        }
      }
    }
    simulate();

    // Draw
    const minX = Math.min(...nodes.map(n => n.x));
    const maxX = Math.max(...nodes.map(n => n.x));
    const minY = Math.min(...nodes.map(n => n.y));
    const maxY = Math.max(...nodes.map(n => n.y));
    const pad = 40;
    const scaleX = (W - pad*2) / Math.max(1, maxX - minX);
    const scaleY = (H - pad*2) / Math.max(1, maxY - minY);
    const scale = Math.min(scaleX, scaleY);

    ctx.clearRect(0, 0, W, H);

    // Edges
    for (const l of links) {
      const alpha = Math.min(1, l.weight / 8);
      ctx.beginPath();
      ctx.moveTo((l.source.x - minX) * scale + pad, (l.source.y - minY) * scale + pad);
      ctx.lineTo((l.target.x - minX) * scale + pad, (l.target.y - minY) * scale + pad);
      ctx.strokeStyle = `rgba(41,151,255,${0.08 + alpha * 0.22})`;
      ctx.lineWidth = Math.max(0.5, l.weight * 0.8);
      ctx.stroke();
    }

    // Nodes
    const maxCount = Math.max(...nodes.map(n => n.count));
    for (const n of nodes) {
      const r = 6 + (n.count / maxCount) * 30;
      const x = (n.x - minX) * scale + pad;
      const y = (n.y - minY) * scale + pad;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const hue = 200 + (n.count / maxCount) * 60;
      ctx.fillStyle = `hsla(${hue}, 70%, 60%, 0.8)`;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label
      if (r > 12) {
        ctx.fillStyle = "#fff";
        ctx.font = `${Math.min(13, r/1.5)}px system-ui,sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(n.name, x, y + 4);
      }
    }
  }

  /* ================================================================== */
  /* 4. Markdown Export (Obsidian/Notion compatible)                      */
  /* ================================================================== */
  function exportMarkdown(metas) {
    let md = "# Markbase 书签知识库\n\n";
    md += `导出时间：${new Date().toLocaleString("zh-CN")}\n`;
    md += `书签总数：${metas.length}\n\n---\n\n`;

    // Group by category
    const byCat = {};
    for (const m of metas) {
      const c = m.category || "未分类";
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(m);
    }

    for (const [cat, items] of Object.entries(byCat).sort()) {
      md += `## ${cat} (${items.length})\n\n`;
      for (const b of items) {
        md += `### [${b.title || "未命名"}](${b.url})\n`;
        if (b.summary) md += `> ${b.summary}\n\n`;
        md += `- **评分**：${b.score ? "⭐".repeat(Math.ceil(b.score/2)) + ` ${b.score}/10` : "未评分"}\n`;
        if (b.scoreReason) md += `- **评语**：${b.scoreReason}\n`;
        md += `- **标签**：${(b.tags||[]).map(t => `#${t}`).join(" ") || "无"}\n`;
        if (b.smartFolder?.length) md += `- **智能文件夹**：${b.smartFolder.join(" / ")}\n`;
        if (b.notes) md += `- **笔记**：${b.notes}\n`;
        if (b.status) md += `- **状态**：${b.status === "read" ? "✅ 已读" : "📖 待读"}\n`;
        md += `- **域名**：${(()=>{try{return new URL(b.url).hostname}catch{return b.url}})()}\n`;
        md += `\n`;
      }
    }
    return md;
  }

  /* ================================================================== */
  /* 5. Random Discovery                                                 */
  /* ================================================================== */
  function randomDiscovery(metas) {
    const old = metas.filter(m => m.summary);
    if (old.length === 0) return null;
    // Weight: older + higher score = more likely
    const now = Date.now();
    const weights = old.map(m => {
      const age = (now - m.addedAt) / (1000 * 60 * 60 * 24); // days
      const ageScore = Math.min(10, age / 30);
      const scoreBonus = (m.score || 5) / 2;
      return { ...m, weight: ageScore + scoreBonus };
    });
    const totalW = weights.reduce((s, m) => s + m.weight, 0);
    let r = Math.random() * totalW;
    for (const m of weights) { r -= m.weight; if (r <= 0) return m; }
    return weights[weights.length - 1];
  }

  function timeAgo(ts) {
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days < 1) return "今天";
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days/30)} 个月前`;
    return `${Math.floor(days/365)} 年前`;
  }

  /* ================================================================== */
  /* 6. Daily Pick                                                       */
  /* ================================================================== */
  function dailyPick(metas) {
    const candidates = metas.filter(m => m.summary && (m.score || 5) >= 6);
    if (candidates.length === 0) return null;
    // Pick based on score + tag diversity
    const scored = candidates.map(m => {
      const tagDiversity = new Set(m.tags || []).size;
      return { ...m, _score: (m.score || 5) * 2 + tagDiversity * 3 };
    });
    scored.sort((a, b) => b._score - a._score);
    return scored[Math.floor(Math.random() * Math.min(5, scored.length))];
  }

  /* ================================================================== */
  /* 7. Weekly Report (text generation via LLM)                           */
  /* ================================================================== */
  async function weeklyReport(onProgress) {
    const metas = await getMetas();
    const now = Date.now();
    const weekAgo = now - 7 * 86400000;

    const newThisWeek = metas.filter(m => m.addedAt > weekAgo).length;
    const unread = metas.filter(m => m.status === "unread").length;
    const avgScore = metas.filter(m => m.score).reduce((s, m) => s + m.score, 0) / Math.max(1, metas.filter(m => m.score).length);

    const catCounts = {};
    const tagCounts = {};
    for (const m of metas) {
      if (m.category) catCounts[m.category] = (catCounts[m.category] || 0) + 1;
      if (m.tags) for (const t of m.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    const topCats = Object.entries(catCounts).sort((a,b) => b[1]-a[1]).slice(0,5);
    const topTags = Object.entries(tagCounts).sort((a,b) => b[1]-a[1]).slice(0,10);

    // Best bookmark
    const best = metas.filter(m => m.score).sort((a,b) => b.score - a.score)[0];
    // Oldest high-quality unread
    const oldUnread = metas.filter(m => m.status === "unread" && m.summary).sort((a,b) => a.addedAt - b.addedAt)[0];

    // Generate summary with LLM
    let summary = "";
    try {
      onProgress && onProgress("生成周报...");
      const s = await getSettings();
      const provider = s.chatProvider || "deepseek";
      const prompt = `根据以下数据生成一份简短的"书签周报"（用中文，保持三段话以内，风格像朋友聊天）：

本周新增：${newThisWeek} 条
待读书签：${unread} 条
平均评分：${avgScore.toFixed(1)}/10
活跃分类：${topCats.map(([n,c])=>`${n}(${c})`).join("、")}
热门标签：${topTags.map(([n,c])=>n).join("、")}
${best ? `最高评分书签：《${best.title?.slice(0,40)}》(评分 ${best.score}/10)` : ""}
${oldUnread ? `最旧的待读书签：《${oldUnread.title?.slice(0,40)}》(收藏于 ${timeAgo(oldUnread.addedAt)})` : ""}

直接返回周报正文，不要标题，不要其他格式。`;
      const result = await LLM.textCall({
        provider,
        systemPrompt: "你是一个友好的书签助手。返回纯文本周报。",
        userPrompt: prompt,
        temperature: 0.6
      });
      summary = result?.summary || result || "";
    } catch (e) { summary = ""; }

    // Fallback text report
    if (!summary) {
      summary = `本周新增 ${newThisWeek} 条书签，还有 ${unread} 条等待阅读。平均评分 ${avgScore.toFixed(1)}/10。你最活跃的领域是 ${topCats[0]?.[0] || "未知"}。${best ? `评分最高的是《${best.title?.slice(0,30)}》。` : ""}`;
    }

    return {
      newCount: newThisWeek,
      unread,
      avgScore: avgScore.toFixed(1),
      topCats: topCats.map(([n]) => n),
      topTags: topTags.map(([n]) => n),
      best: best ? { title: best.title, score: best.score } : null,
      oldUnread: oldUnread ? { title: oldUnread.title, addedAt: oldUnread.addedAt } : null,
      summary
    };
  }

  /* ================================================================== */
  /* 8. Batch fetch thumbnails (lightweight, no LLM)                      */
  /* ================================================================== */
  async function batchFetchThumbnails(metas, onProgress, force = false) {
    const needThumbs = force
      ? metas.filter(m => m.summary)
      : metas.filter(m => m.summary && (!m.thumbnails || m.thumbnails.length < 6));
    if (needThumbs.length === 0) return { done: 0, msg: "所有已分析书签都有缩略图，可强制重新抓取" };

    let done = 0;
    for (const m of needThumbs) {
      onProgress && onProgress(`抓取缩略图 ${done + 1}/${needThumbs.length}`);
      try {
        const page = await LLM.fetchPageContent(m.url);
        if (page.images.length > 0) {
          m.thumbnails = page.images.slice(0, 12).map(i => ({ url: i.url, source: i.source }));
          await metaPut(m);
        }
        done++;
      } catch (e) { done++; continue; }
      await new Promise(r => setTimeout(r, 200));
    }
    return { done, msg: `缩略图已更新：${done} 条` };
  }

  /* ================================================================== */
  /* 8b. Vision AI curation — select best image + captions                */
  /* ================================================================== */
  async function batchVisionCurate(metas, onProgress) {
    const toCurate = metas.filter(m => m.thumbnails && m.thumbnails.length > 0 && !m.bestThumb);
    if (toCurate.length === 0) return { done: 0, msg: "所有缩略图已精选" };

    let done = 0;
    for (const m of toCurate) {
      onProgress && onProgress(`视觉精选 ${done + 1}/${toCurate.length}`);
      try {
        const result = await LLM.visionSelectBest(m.thumbnails, m.title, m.url);
        if (result.bestUrl) {
          m.bestThumb = result.bestUrl;
          m.thumbCaptions = result.captions || [];
          await metaPut(m);
        }
        done++;
      } catch (e) { done++; continue; }
      await new Promise(r => setTimeout(r, 400));
    }
    return { done, msg: `视觉精选完成：${done} 条` };
  }

  return {
    getMetas, metaPut,
    scoreBookmarks, smartFolders, renderGraph, exportMarkdown,
    randomDiscovery, dailyPick, weeklyReport, timeAgo,
    batchFetchThumbnails, batchVisionCurate,
    checkLinksHealth
  };

  /* ================================================================== */
  /* 9. Link Health Check                                                */
  /* ================================================================== */
  async function checkLinksHealth(metas, onProgress) {
    const toCheck = metas.filter(m => !m.linkStatus || m.linkStatus === "unchecked");
    if (toCheck.length === 0) return { ok: metas.filter(m => m.linkStatus === "ok").length, dead: metas.filter(m => m.linkStatus === "dead").length, msg: "所有链接已检查" };

    let ok = 0, dead = 0, redirect = 0, timeout = 0;
    for (let i = 0; i < toCheck.length; i++) {
      const m = toCheck[i];
      onProgress && onProgress(`检查 ${i + 1}/${toCheck.length}`);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(m.url, { method: "HEAD", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
        clearTimeout(timer);
        if (res.ok) { m.linkStatus = "ok"; ok++; }
        else if (res.status >= 300 && res.status < 400) { m.linkStatus = "redirect"; redirect++; }
        else { m.linkStatus = "dead"; dead++; }
      } catch (e) {
        if (e.name === "AbortError") { m.linkStatus = "timeout"; timeout++; }
        else { m.linkStatus = "dead"; dead++; }
      }
      await metaPut(m);
      await new Promise(r => setTimeout(r, 100));
    }

    // Also count existing checks
    const allOk = metas.filter(m => m.linkStatus === "ok").length;
    const allDead = metas.filter(m => m.linkStatus === "dead").length;
    return { ok: allOk, dead: allDead, redirect, timeout, msg: `健康检查完成：${allOk} 正常，${allDead} 失效` };
  }
})();

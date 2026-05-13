# Markbase — AI Bookmark Knowledge Base

> AI 驱动的浏览器书签管理扩展。自动深入网页抓取内容，多模型协同分析，精准分类和标签生成。

## 核心能力

- **自动同步** — 一键接管浏览器全部书签，新增/删除实时同步
- **深度内容分析** — 抓取页面正文、OG 图片，文本 + 视觉模型联合分析
- **智能标签** — AI 自动生成摘要、分类、标签，比只看标题精准得多
- **多模型路由** — DeepSeek 文本 + 千问视觉 + 豆包 + 自定义 OpenAI 兼容 API
- **悬浮 AI 助理** — 自带 Markbase 知识库上下文，支持图片粘贴和流式对话
- **毛玻璃 UI** — 深色 Apple 风格，侧栏分类筛选 + 标签云 + 全文搜索
- **完全本地** — 所有数据存 IndexedDB，API Key 不离开浏览器

## 模型支持

| 模型 | 文本 | 图片 | 默认用途 |
|------|:--:|:--:|------|
| DeepSeek | ✅ | ❌ | 文本聊天、书签分析 |
| 通义千问 | ✅ | ✅ | 图片理解、视觉分析 |
| 豆包 | ✅ | ✅ | 图片理解、视觉分析 |
| 自定义 | ✅ | ✅ | 任意 OpenAI 兼容接口 |

## 安装

1. `git clone` 或下载本项目
2. Chrome → `chrome://extensions`
3. 打开「开发者模式」→「加载已解压的扩展程序」
4. 选择项目文件夹

## 使用

1. 安装后自动同步浏览器书签
2. 左侧「API 设置」→ 填入 DeepSeek / 千问 / 豆包 Key
3. 「AI 批处理」→ 自动分析未分类书签
4. 「深度重新分析」→ 用完整管线（页面抓取 + 图片识别）重新分析全部
5. 右下角蓝色 FAB → 打开 AI 悬浮窗对话

## 架构

```
manifest.json       → Chrome MV3 扩展配置
background.js       → Service Worker，监听书签新增/删除
llm.js              → 统一 LLM 调用层（流式聊天 + 视觉 + 深度分析）
chat-manager.js     → 悬浮 AI 对话窗口 + 多对话管理
dashboard.html/css/js → 全功能面板（Apple 风格毛玻璃 UI）
popup.html/css/js   → 工具栏弹窗（快捷搜索）
```

## 技术栈

- 纯原生 HTML/CSS/JS，零框架零依赖
- Chrome MV3 Extension APIs
- IndexedDB + chrome.storage.local
- Canvas 图片压缩
- ReadableStream 流式输出
- IntersectionObserver 滚动动画

## 隐私

所有数据存储在浏览器本地。API Key 仅用于向对应服务商发起请求，不会上传到任何第三方服务器。

## License

MIT

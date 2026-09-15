# p5 · 私人摄影灵感 1.0 架构文档

版本：1.0
最后更新：2026-09-15
仓库：https://github.com/xbtshady/p5

---

## 一、技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | React 18 + Vite + React Router | 私人 Web App，无 SSR/SEO/复杂路由需求，Next.js 是过度工程 |
| 后端 | CloudBase（Web 托管 + Database + Storage） | 1.0 不需要 API Server，前端直连即可 |
| 部署 | GitHub → CloudBase 自动部署 | git push 即上线，个人项目最爽的节奏 |
| PWA | Vite PWA 插件 + manifest + 主屏图标 | 1.0 只做主屏图标/全屏/手机适配，不做复杂离线缓存 |
| 图片压缩 | browser-image-compression | 前端压缩后再上传，省流量省存储 |

**不用 Next.js 的理由**：这是一个私人 Web App，没有 SSR、SEO、复杂路由这些需求。Vite + React 足够。

**不用 API Server 的理由**：给个人摄影笔记项目加 Controller/Service/Database 三层结构是增加不必要的复杂度。1.0 让前端直连 CloudBase 即可。

---

## 二、整体架构

```
                 手机
                  │
                  ▼
        ┌─────────────────────┐
        │  Photography Web    │
        │   App / PWA         │
        │  (React + Vite)     │
        └──────────┬──────────┘
                   │
            CloudBase SDK
                   │
       ┌───────────┴───────────┐
       │                       │
       ▼                       ▼
┌─────────────┐         ┌─────────────┐
│  Database   │         │   Storage   │
│             │         │             │
│ PhotoNote   │         │   图片      │
└─────────────┘         └─────────────┘
```

**前端负责**：页面、上传、编辑、浏览、搜索、标签筛选。
**CloudBase 负责**：网站部署、图片存储、数据存储。

---

## 三、1.0 数据流（无云函数）

```
上传图片
    ↓
CloudBase Storage  →  返回 imageUrl
    ↓
保存笔记（含 imageUrl）
    ↓
CloudBase Database  →  PhotoNote 集合
    ↓
读取案例
    ↓
CloudBase Database  →  按时间倒序返回
```

**1.5 接入 AI 后的扩展点**：

```
前端
 ↓
Cloud Function  ← 1.5 新增
 ↓
AI API（OpenAI 兼容 /chat/completions）
 ↓
分析结果  →  写入 PhotoNote.observation
完整对话  →  写入 PhotoNote.aiThread
```

---

## 四、数据模型

### PhotoNote 集合（CloudBase Database）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_id` | string | 自动 | CloudBase 主键 |
| `imageUrl` | string | 是 | Storage 文件 URL |
| `title` | string | 否 | 标题 |
| `note` | string | 否 | 直觉 |
| `observation` | string | 否 | 提炼 |
| `nextAttempt` | string | 否 | 行动 |
| `source` | string | 否 | 来源 |
| `tags` | string[] | 否 | 标签数组（1.0 混用，1.5 拆维度） |
| `aiThread` | object[] | 否 | AI 对话线程（1.0 预留空数组） |
| `writeToken` | string | 是 | 安全校验字段，写入时附 |
| `createdAt` | date | 自动 | 创建时间 |
| `updatedAt` | date | 自动 | 更新时间 |

示例文档：

```json
{
  "_id": "auto-generated",
  "imageUrl": "cloud://p5.xxx/photos/2026-09-15-xxx.webp",
  "title": "低机位让我重新认识环境人像",
  "note": "这个角度以前完全没想过。",
  "observation": "人物位置并不特别，但低机位让建筑占据大量画面。",
  "nextAttempt": "下次拍环境人像时尝试一次低机位。",
  "source": "Pinterest",
  "tags": ["低机位", "环境人像", "构图"],
  "aiThread": [],
  "writeToken": "<16位随机口令>",
  "createdAt": "2026-09-15T15:00:00Z",
  "updatedAt": "2026-09-15T15:00:00Z"
}
```

---

## 五、安全规则

### 设计原则

- 私人项目，读可放开（只有你自己知道 URL）
- 写锁死，避免 envId 暴露后任何人能写

### Database 安全规则（PhotoNote 集合）

```js
{
  "read": true,
  "write": "doc.writeToken === '<16位随机口令>'"
}
```

### 实现要点

1. 生成 16 位随机口令（不要用生日/常用词）
2. 口令放 `.env.local`，不入 git 仓库
3. 前端从 `import.meta.env.VITE_WRITE_TOKEN` 读取
4. 写入 PhotoNote 时附 `writeToken` 字段
5. 安全规则硬编码口令校验值（与前端 env 中的值一致）

### `.env.local` 示例

```
VITE_CLOUDBASE_ENV_ID=your-env-id
VITE_WRITE_TOKEN=<16位随机口令>
```

### `.gitignore` 必须包含

```
.env.local
.env.*.local
```

### 安全层级演进

| 版本 | 方案 |
|------|------|
| 1.0 | `writeToken` 软门禁（前端 + 安全规则） |
| 1.5 | Cloud Function BFF，前端不直连 Database |
| 2.0 | 完整鉴权（如果届时有多端/分享需求） |

---

## 六、图片处理流程

```
原图（手机截图 / 相册，10MB+）
    │
    ▼  前端 browser-image-compression
    │
    ▼  压缩到长边 1600–2000px、WebP、约 0.5–2MB
    │
    ▼  上传到 CloudBase Storage
    │
    ▼  返回 imageUrl
    │
    ▼  存入 PhotoNote.imageUrl
```

**理由**：
- 你的目的不是保存摄影原片，而是保存"我为什么喜欢这张照片"
- 10MB 原图塞库加载慢、存储配额浪费
- 前端压缩后再上传，省流量省存储
- 手机上压缩 1–2 秒，但加载速度提升明显

---

## 七、项目结构

```
p5/
├── docs/
│   ├── PRODUCT-1.0.md       # 产品设计文档
│   └── ARCHITECTURE.md      # 架构文档（本文件）
├── src/
│   ├── pages/
│   │   ├── Home/             # 首页（视觉博客流）
│   │   ├── Create/           # 新增案例
│   │   └── Detail/           # 案例详情
│   ├── components/
│   │   ├── PhotoCard/        # 照片卡片
│   │   ├── PhotoUploader/    # 上传+压缩
│   │   ├── Tag/              # 标签组件
│   │   └── Search/           # 搜索框
│   ├── lib/
│   │   └── cloudbase/        # CloudBase SDK 封装
│   ├── App.tsx
│   └── main.tsx
├── public/
│   ├── manifest.json         # PWA manifest
│   └── icons/                # PWA 图标
├── .env.local                # 本地密钥，不入库
├── .gitignore
├── index.html
├── vite.config.ts
└── package.json
```

---

## 八、PWA 配置

**1.0 只做**：
- 主屏幕图标
- 全屏 / 独立窗口
- 手机适配

**1.0 不做**：
- 复杂离线缓存
- Service Worker 预缓存

照片和数据仍走网络访问。

---

## 九、部署流程

### 首次

```
GitHub Repo (github.com/xbtshady/p5)
        │
        ▼
CloudBase 连接 GitHub
        │
        ▼
自动构建
        │
        ▼
自动部署
        │
        ▼
https://你的摄影手册.cloudbase.net
```

### 后续迭代

```
修改代码
   ↓
git push
   ↓
GitHub
   ↓
CloudBase 自动构建
   ↓
自动上线
```

不需要每次手动上传网站。CloudBase 官方支持 Web 应用托管和 Git 仓库部署。

---

## 十、前端关键依赖

```json
{
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0",
    "@cloudbase/js-sdk": "^2.0.0",
    "browser-image-compression": "^2.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0",
    "vite-plugin-pwa": "^0.17.0",
    "typescript": "^5.0.0"
  }
}
```

---

## 十一、扩展点（1.5+）

### 1.5 接入 AI

- 新增 Cloud Function：`analyzePhoto`
- 前端调用 CF，传 `imageUrl` + 用户的"想问什么"
- CF 调 OpenAI 兼容 `/chat/completions`（复用 2.0 产品的 p2.ai 配置：apiKey / baseUrl / model）
- AI 输出写入 `PhotoNote.observation`
- 完整对话存 `PhotoNote.aiThread`

### 1.5 标签分类

- `tags` 拆为 `techTags` / `topicTags` 两个数组
- 1.0 数据迁移：按预置标签清单自动分类（构图/角度/光线 → techTags；环境人像/室内/夜景 → topicTags）

### 2.0 语义搜索

- Cloud Function + 向量数据库
- 索引 `note` + `observation`
- 支持"找出所有和人物与环境关系有关的照片"这类语义检索

### 2.0 BFF 鉴权

- 前端不直连 Database，统一走 Cloud Function
- 完整鉴权（如果届时有多端/分享需求）

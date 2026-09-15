# P5 1.0 架构文档

版本：1.0
最后更新：2026-09-15
仓库：https://github.com/xbtshady/p5

> **前置说明**：本文档最初按 CloudBase 文档数据库（NoSQL）设计。环境开通后发现
> 新版 CloudBase 环境自带的是 **PostgreSQL**（无文档数据库实例），因此数据层、
> 安全模型、目录结构已按 PG 重写。发现过程见文末「附：环境实测记录」。
>
> **当前进度**：0.2 已完成（登录 → 登录成功页 → 退出登录），实现细节见 §5.5。
> 0.1 的 `app_settings` 表已删除。

---

## 一、技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | Vue 3（CDN 引入，无构建起步） | 模板语法 ≈ Thymeleaf，对 Java 开发者零学习成本；无 npm / Vite / 打包 |
| 后端 | CloudBase（Web 托管 + **PostgreSQL** + Storage） | 1.0 不需要 API Server，前端直连即可 |
| 数据访问 | CloudBase JS SDK v3 `app.rdb()` | postgREST 风格查询链，非 NoSQL 的 `app.database()` |
| 部署 | `./deploy.sh`（内部调 `tcb hosting deploy`） | 纯静态上传，不构建；后续可切 GitHub 自动部署 |
| 认证 | CloudBase 身份服务（用户名 + 密码），`tcb user create` 建账号 | 零资质门槛、零额外费用；前端不做注册 |
| PWA | 手写 manifest + 主屏图标 | 1.0 只做主屏图标/全屏/手机适配，不做复杂离线缓存 |
| 图片压缩 | browser-image-compression（CDN） | 前端压缩后再上传，省流量省存储 |
| 数据库迁移 | `cloudbase/migrations/*.sql` + `tcb db pg migration up` | 版本化 DDL，可回放、可审计 |

**为什么不用 React**：项目只有 3 个页面 + 1 个数据结构，不需要组件复用体系、复杂状态管理、前端工程化。React 的 JSX + hooks 是一套独立范式，对 Java 开发者是额外的、没有回报的心智负担。

**为什么不用构建工具（Vite / npm / 打包）**：Vue 3 可以直接用 CDN 引入，在 HTML 的 `<script>` 里写数据和方法。不需要 npm、不需要 Vite、不需要打包产物。哪天页面真的复杂了，再平滑升级到 Vite + 单文件组件，属于渐进增强而非推倒重来。

**为什么不用 API Server**：给个人摄影笔记项目加 Controller/Service/Database 三层结构是增加不必要的复杂度。1.0 让前端直连 CloudBase 即可。写惯 Spring Boot 的人容易条件反射想加后端，这里不需要。

---

## 二、整体架构

```
                 手机
                  │
                  ▼
        ┌─────────────────────┐
        │  Photography Web    │
        │   App / PWA         │
        │   (Vue 3 + CDN)     │
        └──────────┬──────────┘
                   │
      CloudBase JS SDK v3
      （匿名登录 + app.rdb()）
                   │
       ┌───────────┴───────────┐
       │                       │
       ▼                       ▼
┌─────────────┐         ┌─────────────┐
│ PostgreSQL  │         │   Storage   │
│             │         │             │
│ photo_notes │         │   图片      │
│ RLS 策略    │         │             │
└─────────────┘         └─────────────┘
```

**前端负责**：页面、上传、编辑、浏览、搜索、标签筛选。
**CloudBase 负责**：网站部署、图片存储、PG 数据存储与行级权限。

---

## 三、1.0 数据流（无云函数）

```
上传图片
    ↓
CloudBase Storage  →  返回 imageUrl
    ↓
保存笔记（含 imageUrl）
    ↓
PostgreSQL  →  photo_notes 表（INSERT，经 RLS 校验）
    ↓
读取案例
    ↓
PostgreSQL  →  ORDER BY created_at DESC
```

**1.5 接入 AI 后的扩展点**：

```
前端
 ↓
Cloud Function  ← 1.5 新增
 ↓
AI API（OpenAI 兼容 /chat/completions）
 ↓
分析结果  →  写入 photo_notes.observation
完整对话  →  写入 photo_notes.ai_thread
```

---

## 四、数据模型

### 4.1 业务表 `photo_notes`

```sql
CREATE TABLE public.photo_notes (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  image_url    TEXT        NOT NULL,
  title        TEXT,
  note         TEXT,                                  -- 直觉
  observation  TEXT,                                  -- 提炼
  next_attempt TEXT,                                  -- 行动
  source       TEXT,
  tags         TEXT[]      NOT NULL DEFAULT '{}',     -- 1.0 混用，1.5 拆维度
  ai_thread    JSONB       NOT NULL DEFAULT '[]',     -- AI 对话线程（1.0 预留空）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `image_url` | text | Storage 文件 URL |
| `title` | text | 标题 |
| `note` | text | 直觉（"这角度没想过"） |
| `observation` | text | 提炼（外部 AI 聊完回填的要点） |
| `next_attempt` | text | 下次尝试的行动 |
| `source` | text | 来源 |
| `tags` | text[] | 标签数组（1.0 混技法/题材，1.5 拆） |
| `ai_thread` | jsonb | AI 对话线程（1.0 预留空数组） |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

**命名约定**：物理列用 `snake_case`（PG 惯例）；前端 JS 里用 `camelCase`，在 `js/cloudbase.js` 这一层做映射，业务代码不感知。

**标签为什么用 `text[]`**：1.0 只需要"按标签筛选"和"列出所有标签"，PG 的数组类型配合 GIN 索引足够，不必开关联表。等 1.5 真的要拆技法/题材维度、要做标签统计，再迁移成 `tech_tags` / `topic_tags` 两列或关联表。

### 4.2 0.1 walking skeleton 表 `app_settings`

0.1 只验证链路，用一张键值表存 `projectName`：

```sql
CREATE TABLE public.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

后续配置项（如写入口令）也复用这张表，加行即可。

---

## 五、安全模型

### 5.1 身份与角色

CloudBase PG 把访问者映射成 PG 角色：

| 访问者 | PG 角色 | 说明 |
|--------|---------|------|
| 只带 Publishable Key | `anon` | 未登录的公开访问 |
| 匿名登录后的会话 | `authenticated` | 有 JWT，`auth.uid()` 可用 |
| API Key / SecretKey | `service_role` | 管理面，**绕过 RLS，绝不可入前端** |

**Publishable Key 可以放前端**：它只标识应用、本身不带权限，真正的门禁是「服务端 Origin 校验 + 数据库 RLS」。这和 API Key / SecretKey 是两类东西，后者只能留在服务端。

### 5.2 两道门：GRANT + RLS

PG 的权限是**两道独立的门**，缺一不可：

1. **GRANT** —— 角色能不能碰这张表
2. **RLS 策略** —— 能碰哪些行

只做其一都会失败，且报错形态类似「权限不足」，容易误判。1.0 的标准组合：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_notes TO anon, authenticated;
ALTER TABLE public.photo_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY photo_notes_select ON public.photo_notes
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY photo_notes_write ON public.photo_notes
  FOR INSERT TO anon, authenticated WITH CHECK (true);
```

### 5.3 安全层级演进

| 版本 | 方案 |
|------|------|
| 0.1 | RLS 全放开（仅验证链路；该表已在 0.2 删除，暴露面归零） |
| 0.2 | 有登录（用户名密码），但还没有业务表；写保护策略随 `photo_notes` 在 1.0 落地 |
| 1.0 | 读放开；写用 `write_token`：策略校验请求携带的口令，前端从 `js/config.js` 读取 |
| 1.5 | Cloud Function BFF，前端不直连 PG |
| 2.0 | 完整鉴权（按 `auth.uid()` 隔离，如果届时有多端/分享需求） |

> **0.2 到手的能力**：登录后拿到的 JWT 让请求以 `authenticated` 角色执行，
> `auth.uid()` 可用。1.0 因此多了一个比 `write_token` 更干净的选择——
> 直接按 `auth.uid()` 做行级隔离（给 `photo_notes` 加 `owner_id` 列）。
> 两者不冲突：私人项目单账号，`write_token` 够用；哪天要多人用，改走 `owner_id`。

> **1.0 的写保护怎么做**：RLS 里用 `auth.jwt()` 读不到自定义字段，所以做法是
> 在 `photo_notes` 之外用一张 `app_settings` 存 `write_token`，
> 用 `SECURITY DEFINER` 函数或带 `WITH CHECK` 的表达式比对，避免把口令散落在策略里。
> 具体形态在动 1.0 写入口时再定稿。

### 5.4 安全规则脚本位置

DDL / GRANT / POLICY 全部走版本化迁移：

```
cloudbase/migrations/<14位UTC时间戳>_<snake_case名称>.sql
```

应用：`tcb db pg migration up -e <envId>`

### 5.5 认证实现（0.2）

**登录方式**：用户名 + 密码。选它是因为零资质门槛、零额外费用，且
CloudBase 的短信/微信登录各有前提（短信按条计费；微信登录要求微信开放平台
「网站应用」，个人主体申请不了）。

**核心调用**（`js/cloudbase.js`）：

```js
const auth = app.auth({ persistence: "local" });

// 登录
const res = await auth.signInWithPassword({ username, password });
// ⚠️ SDK 把失败放在返回值里，不 throw —— 必须显式判 res.error
if (res && res.error) throw new Error(...);

// 查当前用户（同时触发从本地存储恢复会话）
await auth.getLoginState();
const s = await auth.getSession();
const user = s?.data?.session?.user ?? null;

// 退出
await auth.signOut();
```

**会话持久化**：`persistence: "local"` 把会话写进 `localStorage`。实测写入的 key：

```
credentials_<envId>      # 会话凭证（access/refresh token）
user_info_<envId>        # 用户信息快照
device_id
lang_<envId>
```

因此**刷新页面、关掉标签页再打开，登录态都还在**（已实测验证）。
`getSession()` 是判断登录态的唯一依据；`getLoginState()` 只当"触发恢复"用，
因为它的返回值形态在不同 SDK 版本间不一致。

**登录后能拿到的用户字段**（本环境实测）：

| 字段 | 值示例 | 用途 |
|------|--------|------|
| `user.id` | `2099787376151265282` | 用户唯一标识 |
| `user.user_metadata.nickName` | `Vixtel` | 显示名 |
| `user.user_metadata.username` | `vixtel` | 登录用户名 |
| `user.user_metadata.uid` | 同 `user.id` | — |
| `user.created_at` | `2026-09-15T09:08:17Z` | 注册时间（UTC） |
| `user.app_metadata.providers` | `["cloudbase"]` | 登录来源 |

**拿不到的**：头像、手机号、邮箱（本环境都是空字符串）。
所以「登录成功页」的头像用**昵称首字母 + 纯色圆底**代替。
将来接微信登录时，头像是否能拿到要重新实测——微信这几年在持续收紧用户信息授权。

**账号从哪来**：前端**不做注册**。私人项目，账号由命令行创建：

```bash
tcb user create <用户名> --password <密码> --nickname <显示名> \
  --type externalUser -e <envId>
```

**错误提示**：`js/cloudbase.js` 里 `friendly()` 把 SDK 的英文错误映射成中文
（凭证错误统一说"用户名或密码不正确"，不区分"用户不存在/密码错"，避免账号枚举），
同时 `console.warn` 保留原始错误供排查。

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
    ▼  存入 photo_notes.image_url
```

**理由**：
- 你的目的不是保存摄影原片，而是保存"我为什么喜欢这张照片"
- 10MB 原图塞库加载慢、存储配额浪费
- 前端压缩后再上传，省流量省存储
- 手机上压缩 1–2 秒，但加载速度提升明显

> ⚠️ PG 环境的存储在 Supabase 同款模型下，**桶必须先存在**，浏览器 SDK 不能建桶。
> 1.0 开始写上传前要先确认 Storage 桶已建好并配好 `storage.objects` 的 RLS，
> 否则会拿到 `STORAGE_BUCKET_NOT_FOUND` / `STORAGE_PERMISSION_DENIED`。

---

## 七、项目结构

```
p5/
├── docs/
│   ├── PRODUCT-1.0.md          # 产品设计文档
│   └── ARCHITECTURE.md         # 架构文档（本文件）
├── cloudbase/
│   └── migrations/             # PG 版本化迁移（DDL / GRANT / RLS）
│       └── 20260915082200_init_app_settings.sql
├── index.html                  # 首页（照片流）；0.1 阶段是 walking skeleton
├── create.html                 # 新增案例
├── detail.html                 # 案例详情
├── css/
│   └── style.css               # 全局样式（手机优先）
├── js/
│   ├── config.example.js       # 配置模板（入库）
│   ├── config.js               # 真实配置 envId + accessKey（不入库）
│   ├── cloudbase.js            # CloudBase SDK 封装（匿名登录 + app.rdb()）
│   └── app.js                  # Vue 实例 + 页面逻辑
├── icons/                      # PWA 图标
├── manifest.json               # PWA manifest
├── .gitignore
└── README.md
```

**页面导航**：三个 HTML 页面共用 `js/` 下的脚本，页面间用原生 `<a href>` 跳转，详情页用 URL 参数传 id（如 `detail.html?id=xxx`）。这是 Java 开发者熟悉的多页面模型（类似 JSP 多页面），不是 SPA 前端路由。

---

## 八、PWA 配置

**1.0 只做**：
- 主屏幕图标
- 全屏 / 独立窗口
- 手机适配

**1.0 不做**：
- 复杂离线缓存
- Service Worker 预缓存

**实现方式**：手写 `manifest.json`，在 3 个 HTML 的 `<head>` 里加 `<link rel="manifest" href="/manifest.json">` 即可。不引入 PWA 构建插件。

照片和数据仍走网络访问。

---

## 九、部署流程

### 首次开通环境（已完成）

```
注册/登录腾讯云 → 开通 CloudBase 环境
    ↓
开启「匿名登录」（默认关闭，不开则 SDK 报 login_type_disabled）
    ↓
创建 Publishable Key（PG 环境浏览器访问必需）
    ↓
tcb db pg migration up -e <envId>   ← 建表 + GRANT + RLS
```

### 部署静态站点

```bash
# 本地目录直接上传，纯静态不构建
tcb hosting deploy . -e <envId>
```

当前环境已开通静态托管，默认域名：
`https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com`

### 后续可切的自动部署

```
修改代码 → git push → GitHub → CloudBase 拉取并部署 → 自动上线
```

CloudBase 官方支持连接 Git 仓库。无构建项目直接部署静态文件，构建命令留空。

> ⚠️ **注意**：`js/config.js` 不入 git 仓库，所以纯 GitHub 自动部署拿不到配置。
> 走自动部署时，需要把 `envId` / `accessKey` 改成构建期注入，或接受「配置只在本地部署时生效」。
> 1.0 阶段用 CLI 部署最省事。

---

## 十、CDN 引入清单

无需 npm / `package.json`。三个 HTML 页面各自在 `<head>` 引入：

```html
<!-- Vue 3（生产版全局构建）—— jsdelivr 直连最快，unpkg 会 302 跳转多耗约 1 秒 -->
<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>

<!-- 图片压缩（UMD） -->
<script src="https://cdn.jsdelivr.net/npm/browser-image-compression@2/dist/browser-image-compression.js"></script>

<!-- CloudBase JS SDK —— 官方 CDN 地址（注意不是 unpkg） -->
<script src="https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js"></script>
```

**Vue 必须同步加载，不能加 `defer`/`async`**：`js/*.js` 里判断 `typeof Vue === "undefined"`
做兜底提示，顺序打乱会误报。同理，`js/config.js` 要排在 `js/cloudbase.js` 之前。

> CDN 具体路径以各库官方文档为准；建议锁定版本号，避免上游更新导致行为变化。

---

## 十一、扩展点（1.5+）

### 1.5 接入 AI

- 新增 Cloud Function：`analyzePhoto`
- 前端调用 CF，传 `image_url` + 用户的"想问什么"
- CF 调 OpenAI 兼容 `/chat/completions`（复用 2.0 产品的 p2.ai 配置：apiKey / baseUrl / model）
- AI 输出写入 `photo_notes.observation`
- 完整对话存 `photo_notes.ai_thread`

> ⚠️ 注意：匿名登录用户默认**不能**调用 AI 模型，需要单独授权该权限。

### 1.5 标签分类

- `tags` 拆为 `tech_tags` / `topic_tags` 两个数组
- 迁移：按预置标签清单自动分类（构图/角度/光线 → tech_tags；环境人像/室内/夜景 → topic_tags）

### 2.0 语义搜索

- **这一条换 PG 之后反而更好走**：CloudBase PG 原生支持 `pgvector`，
  不需要额外接一个向量数据库
- 加一列 `embedding vector(1024)`，建 HNSW 索引
- 索引 `note` + `observation`
- 支持"找出所有和人物与环境关系有关的照片"这类语义检索

### 2.0 BFF 鉴权

- 前端不直连 PG，统一走 Cloud Function
- 完整鉴权（如果届时有多端/分享需求）

---

## 附：环境实测记录

开通环境后实测到的事实（供后续排查参考）：

| 项 | 值 |
|----|-----|
| envId | `p5-d4g6dukvb86de1377`（新版格式，非 `env-` 前缀） |
| 地域 | `ap-shanghai` |
| 套餐 | 体验版（免费额度） |
| 环境类型 | `baas` |
| 静态托管域名 | `p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com` |
| 存储 Bucket | `7035-p5-d4g6dukvb86de1377-1312626975` |
| **数据库** | **PostgreSQL 实例 `pgdb-49arptm9`（无文档数据库）** |
| SDK 初始化 | 只传 `env` + `accessKey`，**不要写死 region**（新版环境自动解析） |

**踩过的坑**：

1. **匿名登录默认关闭** —— SDK 报 `login_type_disabled`（errorCode 4045）。
   需 `ModifyLoginConfig` 开启，且四个登录开关（`AnonymousLogin` / `UserNameLogin` /
   `PhoneNumberLogin` / `EmailLogin`）都是**必填**，改一个也要全传，否则会被重置。
2. **没有文档数据库** —— `db.collection().doc().set()` 报 `DATABASE_COLLECTION_NOT_EXIST`，
   提示本环境是 PG。必须改用 `app.rdb()`。
3. **PG API 方法名和 NoSQL 不同** —— 见下表，写错了会静默失败或报奇怪错误。

| ❌ NoSQL / ORM 习惯 | ✅ PG / postgREST |
|---------------------|-------------------|
| `.where({ field: value })` | `.match({ field: value })` 或 `.eq("field", value)` |
| `.orderBy("f", { ascending: false })` | `.order("f", { ascending: false })` |
| `.count()` | `.select("*", { count: "exact" })` |
| `.offset(n)` | `.range(from, to)`（**两端都包含**） |

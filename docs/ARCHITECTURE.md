# P5 架构文档

版本：0.6
最后更新：2026-09-17
仓库：https://github.com/xbtshady/p5

> **前置说明**：本文档最初按 CloudBase 文档数据库（NoSQL）设计。环境开通后发现
> 新版 CloudBase 环境自带的是 **PostgreSQL**（无文档数据库实例），因此数据层、
> 安全模型、目录结构已按 PG 重写。发现过程见文末「附：环境实测记录」。
>
> **当前进度**：0.6 已完成（冷灰 + 磨砂改版）。
> 0.1 的 `app_settings` 表已删除（§4.3）；0.2 登录见 §5.5；
> 0.3 照片表与用户隔离见 §4.1、§5.6；0.4 组件库接入见 §8；0.5 删除见 §5.6；
> 0.6 的视觉规范见 **[DESIGN.md](DESIGN.md)**（另立文档，不放在这里）。
> 文档里凡标「1.0」的部分都是还没做的目标，标「已实现」的是当前线上真实行为。

---

## 一、技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | Vue 3（CDN 引入，无构建） | 模板语法 ≈ Thymeleaf，对 Java 开发者零学习成本；无 npm / Vite / 打包 |
| UI 组件库 | Vant 4（CDN 引入） | 移动优先；主色只有一个 `--van-primary-color`，换主题成本极低 |
| 视觉规范 | 手写 CSS 变量（冷灰 + 近黑 + 磨砂） | 见 [DESIGN.md](DESIGN.md)；组件库只管控件，不管外壳 |
| 后端 | CloudBase（Web 托管 + **PostgreSQL** + Storage） | 不需要 API Server，前端直连即可 |
| 数据访问 | CloudBase JS SDK v3 `app.rdb()` | postgREST 风格查询链，非 NoSQL 的 `app.database()` |
| 文件存储 | `app.storage.from('photos')`（私有桶） | 读取走临时签名 URL，不发直链 |
| 部署 | `./deploy.sh`（内部调 `tcb hosting deploy`） | 纯静态上传，不构建；后续可切 GitHub 自动部署 |
| 认证 | CloudBase 身份服务（用户名 + 密码），`tcb user create` 建账号 | 零资质门槛、零额外费用；前端不做注册 |
| 图片压缩 | browser-image-compression（CDN） | 前端压缩后再上传，省流量省存储 |
| 数据库迁移 | `cloudbase/migrations/*.sql` + `tcb db pg migration up` | 版本化 DDL，可回放、可审计 |
| PWA | 手写 manifest + 主屏图标 | **1.0 计划，尚未实现** |

**为什么不用 React**：项目只有 3 个页面 + 1 个数据结构，不需要组件复用体系、复杂状态管理、前端工程化。React 的 JSX + hooks 是一套独立范式，对 Java 开发者是额外的、没有回报的心智负担。

**为什么不用构建工具（Vite / npm / 打包）**：Vue 3 可以直接用 CDN 引入，在 HTML 的 `<script>` 里写数据和方法。不需要 npm、不需要 Vite、不需要打包产物。哪天页面真的复杂了，再平滑升级到 Vite + 单文件组件，属于渐进增强而非推倒重来。

**为什么不用 API Server**：给个人摄影笔记项目加 Controller/Service/Database 三层结构是增加不必要的复杂度。让前端直连 CloudBase 即可。写惯 Spring Boot 的人容易条件反射想加后端，这里不需要。

**为什么 UI 框架选 Vant 而不是 Element Plus**（0.4 的选型结论）：

| 维度 | Vant 4 | Element Plus |
|------|--------|--------------|
| 定位 | 移动优先，组件专为触屏设计 | 桌面优先，移动端要额外适配 |
| 体积 | gzip 约 129KB | 约 2 倍于 Vant |
| 换主色 | 一个 `--van-primary-color` 变量 | 8 档派生色阶（light-3/5/7/8/9、dark-2、rgb）都要同步 |
| 本项目需要的组件 | 全都有（Uploader、ImagePreview 自带双指缩放/左右切换） | 有，但语义偏桌面 |

代价：无构建模式下只能引 UMD 全量包（gzip 约 78KB JS），按需引入需要构建工具，不值得为此破坏「无构建」这条底线。

---

## 二、整体架构

```
                 手机
                  │
                  ▼
        ┌──────────────────────────┐
        │   P5   静态站点 / PWA     │
        │   Vue 3 + Vant 4（CDN）   │
        └────────────┬─────────────┘
                     │
        CloudBase JS SDK v3
        （用户名密码登录 + app.rdb() + app.storage()）
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
┌─────────────┐ ┌──────────┐ ┌──────────────┐
│ PostgreSQL  │ │ Storage  │ │   静态托管    │
│             │ │ 私有桶    │ │              │
│ photo_notes │ │ photos/  │ │ HTML/CSS/JS  │
│ RLS 按 uid  │ │ RLS 按路径│ │              │
└─────────────┘ └──────────┘ └──────────────┘
```

**前端负责**：页面、压缩、上传、编辑、浏览、搜索、标签筛选。
**CloudBase 负责**：网站部署、图片存储、PG 数据存储与行级权限。

---

## 三、数据流（无云函数）

已实现（0.3）：

```
选图
 ↓
browser-image-compression（长边 1600px、WebP、q=0.85）
 ↓
上传到私有桶 photos/{uid}/{时间戳}-{随机}.{ext}
 ↓  路径首段的 uid 由 storage.objects 的 RLS 校验
返回桶内路径 storage_path
 ↓
落库 photo_notes（INSERT，owner_id 默认取 auth.uid()，前端传不了）
 ↓
列表页读取（RLS 只返回本人的行，created_at 倒序）
 ↓
把 storage_path 批量换成临时签名 URL（默认 1 小时）→ 渲染
```

删除（0.5）：

```
点卡片右上角 ×
 ↓
确认弹窗（Vant showConfirmDialog，点取消就结束）
 ↓
DELETE photo_notes WHERE id = ?        ← RLS: owner_id = auth.uid()
 ↓  行删掉，列表立刻摘掉这一条
storage.from('photos').remove([path])  ← RLS: 路径首段 = uid
 ↓  失败只 warn：留下孤儿文件，不影响使用
```

**为什么先删行**：反过来先删文件的话，删行一旦失败就留下指向不存在文件的记录（界面破图），比孤儿文件难处理得多。

维度档位（0.11–0.15）：

```
新增页点「生成提示词」→ 手动发给外部 AI → 把回的 JSON 粘回
 ↓  解析器解析成 {维度: 值}，再走 P5.cleanTags 归一化
落库 photo_notes.tags（text[]，元素形如 "镜头:中长焦"）
 ↓
按维度值查：db.from(...).contains('tags', ["镜头:中长焦"])
 ↓  → postgREST 的 tags=cs.{镜头:中长焦} → PG 的 tags @> '{镜头:中长焦}' → GIN 索引
列表页读取（RLS 只返回本人的行，created_at 倒序）

分面筛选（探索区）：select('tags') 只取这一列，客户端 split(':') 后按维度聚合
（postgREST 表达不了 GROUP BY unnest，见 §4.2）
```

**AI 这一步不经过服务端**——剪贴板人工中转。提示词模板、维度字典、解析器都放
`js/facets.js`（0.11），是纯前端函数（可在 Node 里单测）。所以这条链路 0.11–0.13 都不需要任何
云函数，也没有 API key 要管。1.5 站内直连时换成函数调用，字典和解析器原样复用。

**归一化为什么必须只有一道**：`contains()` 对数组参数是 `tags.join(',')` 直接拼串、**不做转义**。标签里混进 `, { } "` 会把 postgREST 的数组字面量拼坏。所以清洗放在 `js/cloudbase.js` 里、写库和查询两条路都过它——分成两份迟早漂移。

**1.5 接入 AI 后的扩展点**：

```
前端
 ↓
Cloud Function  ← 1.5 新增
 ↓
AI API（OpenAI 兼容 /chat/completions，复用 2.0 产品的 p2.ai 配置）
 ↓
分析结果 → 写回 photo_notes.tags / ai_tips
          与 0.13 的剪贴板链路共用同一个解析器，只是把人工中转换成函数调用
```

---

## 四、数据模型

### 4.1 业务表 `photo_notes`（0.3 建，0.7 加 tags，0.10 加 ai_tips）

```sql
CREATE TABLE public.photo_notes (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     TEXT        NOT NULL DEFAULT auth.uid(),
  storage_path TEXT        NOT NULL,
  title        TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 0.7 加入，见迁移 20260918075506_add_tags.sql
  tags         TEXT[]      NOT NULL DEFAULT '{}'
);

-- 0.10 已执行（2026-09-18，迁移 20260918180000_add_ai_tips_and_clear_tags.sql）
ALTER TABLE public.photo_notes
  ADD COLUMN ai_tips TEXT[] NOT NULL DEFAULT '{}';
-- 同一条迁移里清空 tags：旧的自由标签全部退役（见 PRODUCT-1.0 §3.4）。
-- 只清内容，列和 GIN 索引都留着给「维度:值」继续用；照片、标题、描述都没动。

CREATE INDEX photo_notes_owner_created_idx
  ON public.photo_notes (owner_id, created_at DESC);

CREATE INDEX photo_notes_tags_idx
  ON public.photo_notes USING GIN (tags);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `owner_id` | text | 归属人，**默认值取自 JWT**（`auth.uid()`），前端不传也传不了 |
| `storage_path` | text | 桶内路径（不是 URL）。私有桶没有直链，用前要换签名 URL |
| `title` | text | 标题，可选 |
| `note` | text | 描述（自己写的），可选 |
| `tags` | text[] | 维度档位。0.7 加入，0.10 清空旧值，0.12 起写入 `维度:值` 编码。前端传前必须过 `P5.cleanTags` |
| `ai_tips` | text[] | AI 给的「下次这样拍」1-3 条，0.10 加入（已执行），0.13 起写入。**单开一列不并进 `note`**：要能分清哪句是自己写的、哪句是 AI 说的（AI 会错，这个区分以后有用） |
| `created_at` | timestamptz | 创建时间 |
| `updated_at` | timestamptz | 更新时间 |

`ai_tips` **不加索引**：它从不参与筛选（筛选只按 `tags`），只跟着行一起取出来。

**为什么存 `storage_path` 而不是 `image_url`**：桶是私有的，不存在长期有效的直链。存路径、用时换签名 URL，URL 过期也不会让数据失效；反过来存 URL 的话，链接一过期记录就成了死数据。

**索引**：列表查询固定是「按 `owner_id` 过滤 + `created_at` 倒序」，复合索引正好全覆盖。

**命名约定**：物理列用 `snake_case`（PG 惯例）；前端 JS 里用 `camelCase`，在 `js/cloudbase.js` 这一层做映射，业务代码不感知。

### 4.2 为什么维度编码进 `tags`，而不是开新列（0.10）

0.10 起要把扁平标签换成「维度 → 值」。三条路：

| 做法 | 代价 |
|------|------|
| **编码进 `tags`（选定）**：`"镜头:中长焦"` | 零迁移；筛选复用 0.7 的 `contains` 路径（`cs.{镜头:中长焦}`）；维度增删不用迁移；多值维度（姿势）天然支持 |
| 新增 `facets JSONB`，`{"镜头":"中长焦"}` | 语义最干净，但 SDK 的 `contains()` 是数组实现（`join(',')`），传对象会拼成 `[object Object]`；且一个键一个值，多值维度变别扭 |
| 每个维度开一列 | 查询最直观，但**加维度就要迁移**，而维度清单是刻意放开的（AI 可以自己开新维度） |

选第一条不只是省事，它是**低悔选择**：值已经是结构化的 `维度:值`，将来维度清单定死了、
真要拆成独立列，那只是一次机械的 split 迁移，信息一点不丢。反过来先开列，
之后每加一个维度都得迁一次。

**旧标签不迁移**：0.7–0.9 的自由标签（技法 / 题材那批）在 0.10 一次性清空（已执行）。
两套体系并存会让筛选和探索区都得多处理一种情况，而旧数据本身也没多少。

**不用 jsonb**：`tags` 是有序去重的字符串集合，`text[]` 的包含运算符 `@>` 正好对上 GIN 的 `array_ops` 操作符类；jsonb 只能走 `jsonb_ops`，还得多包一层字面量语法。

**统计在客户端做，不在数据库**：`SELECT unnest(tags) t, count(*) ... GROUP BY t` 这种聚合 postgREST 表达不了，要在服务端算就得开云函数或直连 SQL——这个项目刻意没有云函数（见 §3）。个人项目量级下（几百条）只取 `tags` 一列也就几 KB，客户端 split 一遍完全够；真到几千条再换服务端聚合，接口签名不用变。

**⚠️ 值里的危险字符**：SDK 的 `contains()` 对数组参数是 `tags.join(',')` 直接拼串，不做任何转义。`, { } [ ] ( ) " '` 这些字符会把 postgREST 的查询拼坏（轻则筛不出，重则语义变成另一个查询）。防线在 `js/cloudbase.js` 的 `cleanTags`。**0.12 已多拦一个 `:`**——写入口从那版开始产出 `维度:值`，值里再冒出一个冒号会把维度拆错（`cleanTag` 保留第一个冒号，它之后的全清掉）。**别在前端页面里另写一套清洗**。

### 4.3 已删除：0.1 的 `app_settings`

0.1 只验证链路，用一张键值表存 `projectName`：

```sql
CREATE TABLE public.app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

它当时配了 3 条**完全放开**的 RLS（`USING (true)`），任何拿到 Publishable Key 的人都能读写。0.2 有真实登录后这张表失去意义，已在迁移 `20260915091200_drop_app_settings.sql` 中删除，暴露面归零。**这条「测试用表可以全放开」的做法不能沿用到业务表**——`photo_notes` 落地时走的是严格策略。

---

## 五、安全模型

### 5.1 身份与角色

CloudBase PG 把访问者映射成 PG 角色：

| 访问者 | PG 角色 | 说明 |
|--------|---------|------|
| 只带 Publishable Key | `anon` | 未登录的公开访问。0.2 起匿名登录已关闭 |
| 用户名密码登录后的会话 | `authenticated` | 有 JWT，`auth.uid()` 可用 |
| API Key / SecretKey | `service_role` | 管理面，**绕过 RLS，绝不可入前端** |

**Publishable Key 可以放前端**：它只标识应用、本身不带权限，真正的门禁是「服务端 Origin 校验 + 数据库 RLS」。这和 API Key / SecretKey 是两类东西，后者只能留在服务端。

### 5.2 两道门：GRANT + RLS

PG 的权限是**两道独立的门**，缺一不可：

1. **GRANT** —— 角色能不能碰这张表
2. **RLS 策略** —— 能碰哪些行

只做其一都会失败，且报错形态类似「权限不足」，容易误判。`photo_notes` 的实际组合（完整版见迁移文件）：

```sql
-- 第一道：刻意不授 anon —— 未登录连这张表都碰不到
--         DELETE 是 0.5 补上的；仍然不授 UPDATE —— 不做编辑
GRANT SELECT, INSERT, DELETE ON public.photo_notes TO authenticated;

-- 第二道：按行隔离
ALTER TABLE public.photo_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY p5_notes_select ON public.photo_notes
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

CREATE POLICY p5_notes_insert ON public.photo_notes
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

CREATE POLICY p5_notes_delete ON public.photo_notes
  FOR DELETE TO authenticated USING (owner_id = auth.uid());
```

### 5.3 安全层级演进

| 版本 | 方案 |
|------|------|
| 0.1 | RLS 全放开（仅验证链路；`app_settings` 已在 0.2 删除） |
| 0.2 | 有登录（用户名密码），尚无业务表 |
| 0.3 | **实际落地**：`owner_id = auth.uid()` 行级隔离 + 私有桶路径隔离（两层，见 §5.6） |
| 0.4 | 无安全变更（只改样式） |
| 0.5 | 补 `DELETE`：表加 `GRANT DELETE` + 策略，`storage.objects` 加 DELETE 策略（判据与 0.3 相同） |
| 0.7 | 加 `tags` 列：GRANT 是按表授的，**新列自动继承**，GRANT / RLS 一条没动 |
| 0.8 / 0.9 | 标签写入口 / 读出口：无安全变更，筛选仍走 RLS 之上的 `contains` |
| 0.10 | 加 `ai_tips` 列 + 清空 `tags`（**已执行**）：只动列和数据，GRANT / RLS 一条不改（权限按表授，新列自动继承）|
| 0.11–0.15 | 维度字典 / 写入口 / 读出口：无安全变更。0.12 起 `cleanTags` 多拦一个 `:`，那是查询拼接的健壮性，不是权限 |
| 1.0 | 搜索（客户端过滤标题 / 描述 / 维度值），无安全变更 |
| 1.5 | Cloud Function BFF，前端不直连 PG |
| 2.0 | 完整鉴权（多端/分享需求出现时再谈） |

> **`write_token` 方案已放弃**。0.2 之前的设计是「用一张 `app_settings` 存写入口令、
> 在 RLS 里比对」，因为当时没有身份。0.2 有了登录后 `auth.uid()` 就是更好的答案：
> 口令会被任何人从前端 JS 里读到，而 `auth.uid()` 取自 JWT，前端伪造不了。
> 代价是这套隔离天然按账号分库——**账号本身就是隔离边界，不支持"A 看 B 的照片"这种需求**。

### 5.4 安全规则脚本位置

DDL / GRANT / POLICY 全部走版本化迁移：

```
cloudbase/migrations/<14位UTC时间戳>_<snake_case名称>.sql
```

应用：`tcb db pg migration up -e <envId>`

**新增策略时必须先想清楚粒度**：`storage.objects` / `storage.buckets` 的 GRANT 是平台默认对 `anon` / `authenticated` 全开的，那两张表的隔离**完全依赖 RLS**。任何一条策略写松了就是越权，且不会报错。

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
| `user.id` | `2099787376151265282` | 用户唯一标识，也是存储路径首段的 uid |
| `user.user_metadata.nickName` | `Vixtel` | 显示名 |
| `user.user_metadata.username` | `vixtel` | 登录用户名 |
| `user.user_metadata.uid` | 同 `user.id` | — |
| `user.created_at` | `2026-09-15T09:08:17Z` | 注册时间（UTC） |
| `user.app_metadata.providers` | `["cloudbase"]` | 登录来源 |

**拿不到的**：头像、手机号、邮箱（本环境都是空字符串）。
将来接微信登录时，头像是否能拿到要重新实测——微信这几年在持续收紧用户信息授权。

**账号从哪来**：前端**不做注册**。私人项目，账号由命令行创建：

```bash
tcb user create <用户名> --password <密码> --nickname <显示名> \
  --type externalUser -e <envId>
```

**错误提示**：`js/cloudbase.js` 里 `friendly()` 把 SDK 的英文错误映射成中文
（凭证错误统一说"用户名或密码不正确"，不区分"用户不存在/密码错"，避免账号枚举），
同时 `console.warn` 保留原始错误供排查。

### 5.6 用户隔离（0.3）

隔离做**两层**，缺一不可：

| 层 | 手段 | 挡住的场景 |
|----|------|-----------|
| 数据表 | `photo_notes.owner_id = auth.uid()` + 只授 `authenticated` | 拿到别人的记录行（`?select=*` 也只会返回自己的） |
| 照片文件 | 私有桶 `photos` + 对象路径首段 = uid | 拿到（或猜到）URL 就能看图 |

**第二层为什么必须做**：只隔离表而桶是公开的话，别人拿到直链就能看图，第一层等于白做。所以桶 `public = false`，读取一律走临时签名 URL：

```sql
CREATE POLICY p5_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'photos'
    AND (storage.foldername(name))[1] = auth.uid()
  );
```

路径约定 `{uid}/{文件名}`，首段的 uid 不是装饰——换成别人的 uid 会被数据库直接拒绝。

**代码侧约定**（`js/cloudbase.js`）：

- `currentUid()` 未登录直接抛错，**绝不返回 `undefined`**。否则拼出来的路径是 `undefined/xxx`，会绕过意图还好说，更怕是写到别人看不清的位置。
- `listPhotos()` 不传 `owner_id`，由数据库过滤——前端连表达"我要看别人"的能力都没有。
- `signPhotoUrls()` 单张失败不中断整批，失败项留空串，由页面显示「图片暂时取不到」。
- `deletePhoto(id, path)` **先删行、再删文件**：行删掉列表立刻干净，文件万一删失败只留一个看不见的孤儿；反过来先删文件的话，删行一旦失败就会留下指向不存在文件的坏记录（界面破图），比孤儿难处理得多。文件删除失败只 `console.warn`，不让整次删除报错——否则用户会以为没删掉又删一遍。

**删除的权限（0.5）**：表侧 `GRANT DELETE` + `p5_notes_delete`，文件侧 `p5_photos_delete`，判据与读/写完全一致（`owner_id = auth.uid()` / 路径首段 = uid）。三层权限（读、写、删）共用同一套归属判据，不存在某一层松一档的情况。

> 注意：`storage.objects` **不能直接 `DELETE FROM`** —— 平台装了 `protect_delete` 触发器，
> 直接删会报 `Direct deletion from storage tables is not allowed. Use the Storage API instead.`。
> 策略是给 Storage API 那条通路用的，SDK 侧对应 `app.storage.from('photos').remove([path])`。

---

## 六、图片处理流程

```
原图（手机截图 / 相册，10MB+）
    │
    ▼  前端 browser-image-compression
    │
    ▼  长边 1600px、WebP、初始质量 0.85
    │
    ▼  上传到私有桶 photos/{uid}/{时间戳}-{随机}.{ext}
    │
    ▼  返回桶内路径
    │
    ▼  存入 photo_notes.storage_path
```

**理由**：
- 你的目的不是保存摄影原片，而是保存"我为什么喜欢这张照片"
- 10MB 原图塞库加载慢、存储配额浪费
- 前端压缩后再上传，省流量省存储
- 手机上压缩 1–2 秒，但加载速度提升明显

**几条实现约定**：

- **先上传、后落库**。反过来的话，上传失败就会留下一条指向不存在文件的记录。
- **压缩失败退回原图继续**，不因为压缩这一步挡住保存。
- **`maxWidthOrHeight: 1600` 而不是 2000**：手机上 1600px 已经看不出差别，流量省一半。
- 文件名取「时间戳 + 随机串」：PG 模式的 `upload` 默认 `upsert = false`，重名会直接失败，必须避开。
- ⚠️ **已知小瑕疵**：扩展名取自**原文件名**，而压缩后统一是 WebP，所以桶里会出现 `xxx.jpg` 实际内容是 WebP 的情况。不影响显示（浏览器按内容解码），但名字不准确，待顺手修。
- ⚠️ PG 环境的存储在 Supabase 同款模型下，**桶必须先存在**，浏览器 SDK 不能建桶。本环境的 `photos` 桶由迁移文件建好并配好 RLS；重建环境时别忘了这一步，否则会拿到 `STORAGE_BUCKET_NOT_FOUND` / `STORAGE_PERMISSION_DENIED`。

---

## 七、项目结构

```
p5/
├── docs/
│   ├── PRODUCT-1.0.md          # 产品设计文档
│   └── ARCHITECTURE.md         # 架构文档（本文件）
├── cloudbase/
│   └── migrations/             # PG 版本化迁移（DDL / GRANT / RLS）
│       ├── 20260915082200_init_app_settings.sql        # 0.1（已删表）
│       ├── 20260915091200_drop_app_settings.sql        # 0.2
│       ├── 20260916011500_init_photo_notes.sql         # 0.3
│       ├── 20260916033700_add_delete_policies.sql      # 0.5
│       ├── 20260918075506_add_tags.sql                 # 0.7
│       └── 20260918180000_add_ai_tips_and_clear_tags.sql  # 0.10
├── login.html                  # 登录页（入口）
├── index.html                  # 照片流（点图全屏看、卡片右上角删除）
├── create.html                 # 新增照片
├── css/
│   └── style.css               # 全局样式（主题 token + Vant 变量覆盖）
├── js/
│   ├── config.example.js       # 配置模板（入库）
│   ├── config.js               # 真实配置 envId + accessKey（不入库）
│   ├── cloudbase.js            # CloudBase 封装（登录 / 上传 / 落库 / 列表 / 签名 URL / 删除）
│   ├── facets.js               # 0.11：维度字典 + 提示词模板 + 回填解析器（纯函数，可单测）
│   ├── facets.test.js          # facets.js 的断言（node js/facets.test.js，零依赖）
│   ├── login.js                # 登录页逻辑
│   ├── app.js                  # 照片流逻辑
│   └── create.js               # 新增页逻辑
├── deploy.sh                   # 部署脚本
├── .gitignore
└── README.md
```

**页面导航**：三个 HTML 页面共用 `js/` 下的脚本，页面间用原生跳转，属 Java 开发者熟悉的多页面模型（类似 JSP 多页面），不是 SPA 前端路由。`login.html` 是入口，登录成功 `location.replace("index.html")`；`index.html` 发现没登录就 `replace` 回 `login.html`（用 `replace` 不用 `href`，避免返回键来回跳）。

**Vue 无构建模式下的渲染时序约定**（三个页面统一照此实现）：

1. `#app` 加 `v-cloak` + CSS `[v-cloak]{display:none}` —— 挡住 `{{ }}` 被当纯文本渲染出来。
2. **先 `await` 取数据，再 `createApp().mount()`** —— 挂载瞬间页面已是最终内容。只加 `v-cloak` 不够：它挡到挂载完成就收工，挡不住挂载**之后**才发起的数据加载。
3. 挂载前显示独立的 `#boot` 占位层（固定全屏、同底色、居中），`mount()` 后由页面脚本 `remove()` —— 加载期间不白屏，且 CDN 挂了能在占位层里报错。

---

## 八、样式与 UI 组件库

> **视觉规范已独立成文**：[DESIGN.md](DESIGN.md) —— 配色怎么定、磨砂怎么做、
> 布局与动效的硬约束、改样式的标准流程。
> 本节只留**技术接入**相关的部分（组件库怎么装、有哪些会静默失败的坑）。

### 8.1 主题 token 化

配色全部收在 `css/style.css` 的 `:root` 里，改主题只改这一处。
当前是 0.6 的冷灰 + 近黑 + 磨砂（0.4 的暖白 + 墨绿已换掉，理由见 DESIGN.md §1）：

```css
--bg: #d7dbe2;          /* 页面底：冷灰。底色深浅决定磨砂看不看得出来，见 DESIGN.md §2.1 */
--card: #ffffff;        /* 不透明白：输入框、降级卡面 */
--text: #16181c;        /* 正文（白卡 17.8:1，最暗玻璃底 14.8:1） */
--muted: #5c616b;       /* 次要文字（最坏 5.19:1）—— 全站只有这两级文字色 */
--accent: #16181c;      /* 主色：近黑（白字压上去 17.8:1） */
--danger: #bc331c;      /* 破坏性动作（最坏 4.83:1） */
--glass: rgba(255, 255, 255, 0.55);        /* 磨砂卡面 */
--glass-strong: rgba(255, 255, 255, 0.8);  /* 磨砂顶栏 */
```

**对比度必须按最坏情况算**（光斑最暗处 + 玻璃叠加后的底色），不能用白底上的值充数 ——
玻璃让实际底色随背景浮动，改底色或改透度都要重算。

`--van-*` 全部指回这些变量，所以组件库的配色也只有一个来源。

### 8.2 Vant 接入方式与三条硬约定

Vant 靠 CSS 变量做主题，把它的语义色全部指回上面的 `:root` 变量，全站配色仍只有一个来源：

```css
:root {
  --van-primary-color: var(--accent);
  --van-text-color: var(--text);
  --van-uploader-size: 112px;   /* 默认 80 太小，照片应用里它是主角 */
}
```

**约定 1：`css/style.css` 必须排在 Vant 的 `index.css` 之后加载。**
`<link>` 顺序反了的话，上面的 `:root` 会先被定义、再被 Vant 的默认值盖掉，表现为「改了变量不生效」。

**约定 2：`app.use(vant)` 一步都不能漏。**
漏了**不会报错** —— Vue 把 `van-*` 当成未识别的自定义标签原样留在 DOM 里，页面「什么都没显示」，控制台却干干净净。这是本项目踩过的最难查的一次坑，三个页面的脚本里都写了注释提醒。

**约定 3：页面上所有 `van-*` 组件必须写完整闭合标签。**
HTML 不认自定义标签的自闭合，写成 `<van-field />` 会把后面所有同级组件吞成它的子元素，表现为「写了好几个只渲染出一个」。原生 void 元素（`img` / `input`）不受影响。验证手段：headless Chrome 的 `--dump-dom` 数一遍组件个数。

---

## 九、PWA 配置（1.0 计划，尚未实现）

**计划只做**：主屏幕图标、全屏 / 独立窗口、手机适配。

**不做**：复杂离线缓存、Service Worker 预缓存。

**实现方式**：手写 `manifest.json`，在 3 个 HTML 的 `<head>` 里加 `<link rel="manifest" href="/manifest.json">`。不引入 PWA 构建插件。照片和数据仍走网络访问。

---

## 十、部署流程

### 首次开通环境（已完成）

```
注册/登录腾讯云 → 开通 CloudBase 环境
    ↓
开启「用户名密码登录」（匿名登录不开；四个登录开关是必填，改一个也要全传）
    ↓
创建 Publishable Key（PG 环境浏览器访问必需）
    ↓
tcb db pg migration up -e <envId>   ← 建表 + GRANT + RLS + 建桶
```

### 部署静态站点

```bash
./deploy.sh          # 内部：复制站点文件到临时目录 → tcb hosting deploy
```

> ⚠️ **不要手敲 `tcb hosting deploy .`**。CLI 会把只读的 `.git` 一起扫，报
> `Path has no read/write permissions` 直接中断，`--ignore` 各种写法都拦不住。
> 脚本的做法是先把站点文件复制到临时目录，再从那里上传。

当前环境已开通静态托管，默认域名：
`https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com`

### 后续可切的自动部署

```
修改代码 → git push → GitHub → CloudBase 拉取并部署 → 自动上线
```

CloudBase 官方支持连接 Git 仓库。无构建项目直接部署静态文件，构建命令留空。

> ⚠️ **注意**：`js/config.js` 不入 git 仓库，所以纯 GitHub 自动部署拿不到配置。
> 走自动部署时，需要把 `envId` / `accessKey` 改成构建期注入，或接受「配置只在本地部署时生效」。
> 现阶段用 CLI 部署最省事。

---

## 十一、CDN 引入清单

无需 npm / `package.json`。三个 HTML 页面各自在 `<head>` / `</body>` 前引入：

```html
<!-- <head> 里：Vant 的 CSS 必须排在 css/style.css 之前 -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/vant@4/lib/index.css" />
<link rel="stylesheet" href="css/style.css" />

<!-- </body> 前 -->
<!-- Vue 3（生产版全局构建）—— jsdelivr 直连最快，unpkg 会 302 跳转多耗约 1 秒 -->
<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>

<!-- UI 组件库（UMD 全量包；按需引入需要构建工具，不值得为此破坏无构建） -->
<script src="https://cdn.jsdelivr.net/npm/vant@4/lib/vant.min.js"></script>

<!-- 图片压缩（UMD，只有 create.html 需要） -->
<script src="https://cdn.jsdelivr.net/npm/browser-image-compression@2/dist/browser-image-compression.js"></script>

<!-- CloudBase JS SDK —— 官方 CDN 地址（注意不是 unpkg） -->
<script src="https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js"></script>

<!-- 顺序有依赖：config.js → cloudbase.js → 页面脚本 -->
<script src="js/config.js"></script>
<script src="js/cloudbase.js"></script>
<script src="js/app.js"></script>
```

`create.html` 的脚本多一个 `js/facets.js`（维度字典，零依赖纯函数，排在 cloudbase.js 之后、
页面脚本之前）。0.15 起首页也要引它（卡片显示档位、探索区分面筛选都读同一份字典）。

**脚本都不能加 `defer` / `async`**：`js/*.js` 里判断 `typeof Vue === "undefined"` / `typeof vant === "undefined"` 做兜底提示，顺序打乱会误报。同理 `js/config.js` 要排在 `js/cloudbase.js` 之前。

> CDN 具体路径以各库官方文档为准。Vue 已经靠 `@3` 这种大版本号吃自动升级，Vant 同理（`@4`）。

---

## 十二、扩展点（1.5+）

### 1.5 站内直连 AI

0.11–0.13 会把整条链路的**字典、提示词模板、解析器**都做完，只是中转那一环是剪贴板。
1.5 要做的只是把中转换掉：

- 新增 Cloud Function：`analyzePhoto`
- 前端传 `storage_path`（换签名 URL 后交给 AI）+ 当前库里已有的维度名单
- CF 调 OpenAI 兼容 `/chat/completions`（复用 2.0 产品的 p2.ai 配置：apiKey / baseUrl / model）
- 回来的结果过**同一个解析器**（`js/facets.js`），写回 `tags` / `ai_tips`

⚠️ API key 必须留在 CF 里，不能下发到前端。

### 2.0 语义搜索

- **这一条换 PG 之后反而更好走**：CloudBase PG 原生支持 `pgvector`，不需要额外接一个向量数据库
- 加一列 `embedding vector(1024)`，建 HNSW 索引
- 索引 `note` + `title` + 标签
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
| 存储 Bucket | `7035-p5-d4g6dukvb86de1377-1312626975`（业务用私有桶 `photos`） |
| **数据库** | **PostgreSQL 实例 `pgdb-49arptm9`（无文档数据库）** |
| 登录方式 | `UserNameLogin: true`；`AnonymousLogin` 已在 0.2 关闭 |
| SDK 初始化 | 只传 `env` + `accessKey`，**不要写死 region**（新版环境自动解析） |
| `auth.uid()` | 返回 `text`，**无参数**，直接读 JWT |
| `storage.foldername(name)` | 返回 `text[]`，用 `[1]` 取路径首段 |
| `storage.objects` / `buckets` 的 GRANT | 平台默认对 `anon` / `authenticated` 全开，隔离**全靠 RLS** |

**踩过的坑**：

1. **匿名登录默认关闭** —— SDK 报 `login_type_disabled`（errorCode 4045）。需 `ModifyLoginConfig` 开启，且四个登录开关（`AnonymousLogin` / `UserNameLogin` / `PhoneNumberLogin` / `EmailLogin`）都是**必填**，改一个也要全传，否则会被重置。
2. **没有文档数据库** —— `db.collection().doc().set()` 报 `DATABASE_COLLECTION_NOT_EXIST`，提示本环境是 PG。必须改用 `app.rdb()`。
3. **PG API 方法名和 NoSQL 不同** —— 见下表，写错了会静默失败或报奇怪错误。
4. **登录 SDK 的错误不 throw** —— `signInWithPassword` 把失败放在返回值里，不判 `res.error` 会当成登录成功。
5. **部署直接传项目根目录会失败** —— 只读的 `.git/objects` 会卡住 CLI，必须走 `./deploy.sh`。
6. **`app.use(vant)` 漏了不报错** —— 见 §8.2 约定 2。
7. **`<van-field />` 自闭合会吞掉同级组件** —— 见 §8.2 约定 3。
8. **`storage.objects` 不允许直接 DELETE** —— 平台装了语句级 `protect_delete` 触发器，绕过 RLS 行过滤就报 `Direct deletion from storage tables is not allowed. Use the Storage API instead.`。所以删文件只能走 SDK 的 `storage.from('photos').remove([path])`，SQL 里的 DELETE 策略是给那条通路做判据用。
9. **验证 RLS 别只看 `AffectedRows`** —— `tcb db execute` 会把受影响行数算到**最后一条**语句上（末尾 `ROLLBACK` 时恒为 0），看着像策略没生效。可靠写法是让被删的行自己回话：`DELETE ... WHERE id = 5 RETURNING id`，本人执行回显 `["5"]`、他人执行 `Rows: null`。

| ❌ NoSQL / ORM 习惯 | ✅ PG / postgREST |
|---------------------|-------------------|
| `.where({ field: value })` | `.match({ field: value })` 或 `.eq("field", value)` |
| `.orderBy("f", { ascending: false })` | `.order("f", { ascending: false })` |
| `.count()` | `.select("*", { count: "exact" })` |
| `.offset(n)` | `.range(from, to)`（**两端都包含**） |
| `app.uploadFile()` / `app.getTempFileURL()` | `app.storage.from('桶').upload()` / `.createSignedUrl()` |

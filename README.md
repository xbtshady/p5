# P5

线上：https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com

**当前版本 0.4**。已经能用的：

| 版本 | 内容 |
|------|------|
| 0.1 | 打通 CloudBase PostgreSQL 链路（临时表已删） |
| 0.2 | 用户名密码登录 / 退出 |
| 0.3 | 上传照片 + 标题 + 一句话；倒序列表看历史；照片按账号隔离 |
| 0.4 | 淡色主题 + Vant 4 组件库（点图全屏看、上传、表单） |

观察 / 下次尝试 / 标签 / 来源 / 搜索 / 详情页还是 1.0 的内容，见 [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md)。

---

## 改完怎么上线

```bash
./deploy.sh
```

## 本地预览

```bash
python -m http.server 5173
```

打开 http://localhost:5173 ，会跳到登录页。用下面「账号」里的用户名密码登录。

> 别直接双击 `index.html`——`file://` 协议会有跨域问题，必须走本地 HTTP 服务。

---

## 用起来是什么样

- 登录页：用户名 + 密码（Vant 表单），登录成功进照片流
- 照片流：按时间倒序，点照片**全屏看**（双指缩放、左右切换），右上角 `＋` 新增、`退出` 登出
- 新增页：选图后**前端自动压缩**（长边 1600px、WebP，显示「3.2 MB → 420 KB」）再上传，标题和「为什么」都可留空
- 隔离：照片存在**私有桶**里，别人拿到链接也打不开；列表只返回你自己的记录

---

## 账号

**不开放注册**，账号只能用命令行创建：

```bash
tcb user create <用户名> --password <密码> --nickname <显示名> \
  --type externalUser -e p5-d4g6dukvb86de1377
```

建完就能在登录页直接登。日常管理两个入口：

**控制台**：云开发控制台 → 选环境 `p5-d4g6dukvb86de1377` → 「身份认证」→「用户管理」，看列表、建号、禁用、删除都在这里。

**命令行**（本机已装 `tcb`，下面 `<envId>` 都指 `p5-d4g6dukvb86de1377`）：

```bash
tcb user list -e <envId>                            # 看全部账号
tcb user list --username <名字> -e <envId>           # 按用户名查
tcb user update <uid> --password <新密码> -e <envId> # 改密码
tcb user update <uid> --status BLOCKED -e <envId>    # 禁用
tcb user delete <uid> -e <envId>                     # 删除（不可恢复）
```

`<uid>` 从 `list` 的返回里取。

> **忘记密码只能重置**：账号没绑手机/邮箱，走不了验证码改密流程。用上面那条 `update --password` 直接覆盖。

---

## 结构

```
login.html                 登录页（入口）
index.html                 照片流 + 全屏看图
create.html                新增照片（选图 / 压图 / 保存）
css/style.css              样式：主题 token + Vant 变量覆盖
js/config.js               环境配置：envId + accessKey（已被 gitignore）
js/cloudbase.js            CloudBase 封装（登录 / 上传 / 落库 / 列表 / 临时链接）
js/login.js  js/app.js  js/create.js   三个页面各自的逻辑
deploy.sh                  部署脚本
docs/                      产品与架构文档
cloudbase/migrations/      数据库迁移（PostgreSQL）
```

**外部依赖全部走 CDN，无 npm、无构建**：Vue 3（jsdelivr）、Vant 4、browser-image-compression、CloudBase JS SDK。

**三个 HTML 里有两处不能改动的顺序**，改了会静默失效：

1. Vant 的 `index.css` 必须在 `css/style.css` **之前**——样式表里有一层 `--van-*` 覆盖要压在它上面
2. `<script>` 依次是 Vue → Vant → 压缩库 → CloudBase SDK → `js/config.js` → `js/cloudbase.js` → 页面脚本，且**不能加 `defer`/`async`**（脚本里靠 `typeof Vue === "undefined"` 做兜底提示）

**写页面时的两条硬规则**（踩过，很难查）：

- `van-*` 组件必须写**完整闭合标签**，`<van-field />` 会把后面所有同级组件吞成子元素，表现为「写了好几个只渲染出一个」
- 页面脚本里 **`app.use(vant)` 一步都不能漏**，漏了不报错，组件就是渲染不出来

**页面流转**：`login.html` 是入口，登录成功跳 `index.html`；`index.html` 发现没登录就跳回 `login.html`。都是原生跳转的多页面模型，不是 SPA。

---

## 两件容易忘的事

**1. 部署只能用 `./deploy.sh`，别手敲 `tcb hosting deploy .`**
CLI 会连只读的 `.git` 一起扫，报 `Path has no read/write permissions` 直接中断。
脚本的做法是先把站点文件复制到临时目录，再从那里上传。

**2. `js/config.js` 不入库，新机器上要自己补回来**

```bash
curl -o js/config.js https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com/js/config.js
```

它已随站点部署上线，所以直接下载就是最新的。也可以 `cp js/config.example.js js/config.js` 手填——`envId` 在控制台「环境 → 环境概览」，`accessKey` 在「环境 → API Key」。

`accessKey` 是 Publishable Key——只标识应用、本身不带权限，放前端是安全的（真正的门禁是服务端 Origin 校验 + 数据库 RLS）。但**别放 SecretKey**，那是 `service_role`，会绕过 RLS。

---

## 换台电脑（公司 ↔ 家里）

云端的环境、数据库、线上站点都在腾讯云上，**不用重建**。新机器只要三步：

```bash
git clone https://github.com/xbtshady/p5.git D:/mycode/p5 && cd D:/mycode/p5
curl -o js/config.js https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com/js/config.js
npm i -g @cloudbase/cli && tcb login    # 只在需要部署时才做
```

- 第 2 步：`config.js` 不入库，但已随站点上线，下载即可（细节见上面「两件容易忘的事」）
- 第 3 步：CLI 是全局工具，装了才有 `tcb` 命令；`tcb login` 是**账号级**授权，扫码一次即可，登录态存在用户目录、不在项目里
- 每次 `git push` 若要求认证，用 GitHub 用户名 + PAT

---

## 出问题先看这里

| 现象 | 原因 |
|------|------|
| 页面报「未配置 envId / accessKey」 | `js/config.js` 没创建，或值还是空的 |
| 登录报 `PROVIDER_NOT_ENABLED` | 控制台「身份认证 → 登录方式」里没开「用户名密码登录」 |
| 登录一直说用户名或密码不正确 | 用 `tcb user list` 核对用户名；密码忘了就按上面「账号」里的办法重置 |
| 登录成功但刷新又回登录页 | `localStorage` 被清（浏览器隐私模式、手动清理） |
| 页面上 `van-*` 组件一个都不显示，控制台还没报错 | 页面脚本漏了 `app.use(vant)` |
| 写了几个表单字段，只渲染出一个 | 用了自闭合的 `<van-field />`，改成 `<van-field></van-field>` |
| 改了 `--van-*` 变量不生效 | `<link>` 顺序反了，`css/style.css` 必须在 Vant 的 `index.css` 之后 |
| 上传报 `STORAGE_BUCKET_NOT_FOUND` / `STORAGE_PERMISSION_DENIED` | `photos` 桶或 `storage.objects` 的 RLS 没建；确认迁移已 apply |
| 列表里某张显示「图片暂时取不到」 | 临时签名链接（1 小时）过期或生成失败，刷新页面即可 |
| 保存报错说明上传失败 | 设计如此：**上传成功才落库**，不会留下指向不存在文件的记录 |
| 报 403 / CORS | 访问域名不在环境安全域名白名单里 |
| 页面是旧的 | CDN 缓存，强刷 Ctrl+Shift+R，或等几分钟 |

---

## 文档

- [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md) —— 产品定位、字段语义、已实现 / 待补的功能
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 技术选型理由、数据模型、安全模型、部署、环境实测记录

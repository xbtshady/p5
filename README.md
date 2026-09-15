# P5

> 看到好照片 → 30 秒内记下来 → 以后能快速找到 → 慢慢形成自己的摄影参考库。

线上：https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com

**当前版本 0.2**：登录 → 登录成功页（显示用户信息）→ 退出登录。
照片流、新增案例、详情页是 1.0 的内容，还没开始，见 [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md)。

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
index.html                 登录成功页（1.0 会变成照片流）
login.html                 登录页
css/ js/                   样式与脚本（Vue 3 + CloudBase SDK 走 CDN，无构建、无 npm）
js/config.js               环境配置：envId + accessKey（已被 gitignore）
js/cloudbase.js            CloudBase 封装（用户名密码登录 / 退出 / 查当前用户）
js/login.js                登录页逻辑
js/app.js                  登录成功页逻辑
deploy.sh                  部署脚本
docs/                      产品与架构文档
cloudbase/migrations/      数据库迁移（PostgreSQL）
```

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
| 报 403 / CORS | 访问域名不在环境安全域名白名单里 |
| 页面是旧的 | CDN 缓存，强刷 Ctrl+Shift+R，或等几分钟 |

---

## 文档

- [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md) —— 1.0 要做什么、明确不做什么
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 技术选型理由、数据层、安全模型、环境实测记录

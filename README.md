# p5 · 私人摄影灵感

> 看到好照片 → 30 秒内记下来 → 以后能快速找到 → 慢慢形成自己的摄影参考库。

线上：https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com

**当前版本 0.1**：只验证一件事——前端能读出并修改 CloudBase 里存的 `projectName`。

---

## 改完怎么上线

```bash
./deploy.sh
```

## 本地预览

```bash
python -m http.server 5173
```

打开 http://localhost:5173 ，应显示 `hello p5`。

> 别直接双击 `index.html`——`file://` 协议会有跨域问题，必须走本地 HTTP 服务。

---

## 结构

```
index.html                 站点首页
css/ js/                   样式与脚本（Vue 3 + CloudBase SDK 走 CDN，无构建、无 npm）
js/config.js               环境配置：envId + accessKey（已被 gitignore）
js/cloudbase.js            CloudBase 封装（匿名登录 + 读写）
deploy.sh                  部署脚本
docs/                      产品与架构文档
cloudbase/migrations/      数据库迁移（PostgreSQL）
```

---

## 两件容易忘的事

**1. 部署只能用 `./deploy.sh`，别手敲 `tcb hosting deploy .`**
CLI 会连只读的 `.git` 一起扫，报 `Path has no read/write permissions` 直接中断。
脚本的做法是先把站点文件复制到临时目录，再从那里上传。

**2. `js/config.js` 不入库，换环境时从模板复制**

```bash
cp js/config.example.js js/config.js
```

里面两个值：`envId` 在控制台「环境 → 环境概览」，`accessKey` 在「环境 → API Key」。

`accessKey` 是 Publishable Key——只标识应用、本身不带权限，放前端是安全的（真正的门禁是服务端 Origin 校验 + 数据库 RLS）。但**别放 SecretKey**，那是 `service_role`，会绕过 RLS。

---

## 出问题先看这里

| 现象 | 原因 |
|------|------|
| 页面报「未配置 envId / accessKey」 | `js/config.js` 没创建，或值还是空的 |
| 报 `login_type_disabled` | 环境的匿名登录被关了，控制台「登录授权 → 登录方式」重新开启 |
| 报 403 / CORS | 访问域名不在环境安全域名白名单里 |
| 页面是旧的 | CDN 缓存，强刷 Ctrl+Shift+R，或等几分钟 |

---

## 文档

- [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md) —— 1.0 要做什么、明确不做什么
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 技术选型理由、数据层、安全模型、环境实测记录

# p5 · 私人摄影灵感

> 看到好照片 → 30 秒内记下来 → 以后能快速找到 → 慢慢形成自己的摄影参考库。

**当前版本：0.1（walking skeleton）** —— 只验证一件事：前端能显示 CloudBase 里存的 `projectName`，并且能改。整条「前端 → CloudBase → 部署」链路已打通。

- 线上地址：https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com
- 产品设计：[docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md)
- 架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## 目录结构

```
p5/
├── index.html          # 页面：hello {projectName} + 可编辑输入框
├── css/style.css       # 样式（手机优先）
├── js/
│   ├── config.example.js   # 配置模板（入库）
│   ├── config.js           # 真实配置 envId + accessKey（不入库，需自己创建）
│   ├── cloudbase.js        # CloudBase 封装：匿名登录 + app.rdb() 读写
│   └── app.js              # Vue 3 页面逻辑
├── cloudbase/
│   └── migrations/     # PostgreSQL 版本化迁移（建表 / GRANT / RLS）
├── deploy.sh           # 一键部署脚本
└── docs/               # 设计文档
```

无构建、无 npm 依赖。Vue 3 和 CloudBase SDK 都通过 CDN 引入。

---

## 环境现状（已开通，无需重做）

| 项 | 值 |
|----|-----|
| 环境 ID | `p5-d4g6dukvb86de1377` |
| 地域 | `ap-shanghai` |
| 套餐 | 体验版（免费额度） |
| 数据库 | **PostgreSQL**（实例 `pgdb-49arptm9`） |
| 静态托管域名 | `p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com` |
| 登录方式 | 匿名登录已开启；账号密码登录也已开启 |

数据表：`public.app_settings`（键值表，0.1 存 `projectName = p5`），已配好 GRANT + RLS 策略。

---

## 一、填写配置

```bash
cp js/config.example.js js/config.js
```

编辑 `js/config.js` 填入 `envId` 和 `accessKey`（Publishable Key）。

- `envId`：控制台「环境 → 环境概览」
- `accessKey`：控制台「环境 → API Key」；或用 CLI 创建：

  ```bash
  tcb api tcb CreateApiKey --body '{"EnvId":"<envId>","KeyType":"publish_key"}'
  ```

> **Publishable Key 放在前端是安全的** —— 它只标识应用、本身不带权限。
> 真正的门禁是「服务端 Origin 校验 + 数据库 RLS」。
> 但**不要**把 API Key / SecretKey 放进来，那是 `service_role`，会绕过 RLS。

`.gitignore` 已忽略 `js/config.js`，不会提交到仓库。

---

## 二、本地运行

需要起一个本地 HTTP 服务（直接双击 `index.html` 用 `file://` 打开会有跨域问题）：

```bash
python -m http.server 5173
# 或
npx serve .
```

浏览器打开 `http://localhost:5173`，应看到 `hello p5`。改输入框里的值 → 保存 → 刷新，值保持。

> `localhost` 系列 Origin 已在环境安全域名里放行，本地调试不用额外配 CORS。

---

## 三、部署

安装 CLI（一次性）：

```bash
npm i -g @cloudbase/cli
```

登录（一次性，浏览器授权）：

```bash
tcb login
```

部署：

```bash
./deploy.sh
```

脚本会把站点文件复制到临时目录再上传（**不要**直接 `tcb hosting deploy .`，原因见脚本内注释：CLI 会连只读的 `.git` 一起扫，导致权限报错中断）。

部署完 CDN 通常几分钟内刷新；要立刻确认可以用无痕窗口，或：

```bash
curl -H "Cache-Control: no-cache" https://p5-d4g6dukvb86de1377-1312626975.tcloudbaseapp.com
```

---

## 四、验收标准（0.1）

- [x] 线上地址能看到 `hello p5`
- [x] 改输入框 → 保存 → 刷新页面，值仍然是新的
- [x] `js/config.js` 没有被提交到 GitHub（`git status` 看不到它）
- [x] 无关文件（`docs/`、`cloudbase/`、`.git`）没有被上传到线上

---

## 常见问题

**页面显示「未配置 envId」/「未配置 accessKey」**
没创建 `js/config.js`，或字段还是空字符串 / 模板占位值。

**页面显示「CloudBase SDK 未加载」**
CDN 没加载出来，检查网络，或把 SDK 下载到 `js/vendor/` 本地引用。

**报 `login_type_disabled`**
环境的「匿名登录」被关掉了。控制台「登录授权 → 登录方式」重新开启，或：

```bash
tcb api tcb ModifyLoginConfig --body '{"EnvId":"<envId>","PhoneNumberLogin":false,"EmailLogin":false,"UserNameLogin":true,"AnonymousLogin":true}'
```

注意四个开关都是**必填**，改一个也要全传，否则会被重置。

**报 403 / CORS 相关错误**
访问域名不在环境安全域名白名单里。查看和添加：

```bash
tcb cors list
tcb cors add <domain>
```

**读不到数据但也没报错**
检查 `public.app_settings` 表里是否有 `key = 'projectName'` 的行，以及 RLS 策略是否还在。

**部署时报 `Path has no read/write permissions: ...\.git\objects\...`**
用 `./deploy.sh`，不要直接 `tcb hosting deploy .`。

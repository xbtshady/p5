# p5 · 私人摄影灵感

> 看到好照片 → 30 秒内记下来 → 以后能快速找到 → 慢慢形成自己的摄影参考库。

**当前版本：0.1（walking skeleton）** —— 只验证一件事：前端能显示 CloudBase 里存的 `projectName`，并且能改。整条「前端 → CloudBase → 部署」链路打通后，再往里填 1.0 的功能。

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
│   ├── config.js           # 真实配置（不入库，需自己创建）
│   ├── cloudbase.js        # CloudBase 封装：读/写 projectName
│   └── app.js              # Vue 3 页面逻辑
└── docs/                   # 设计文档
```

无构建、无 npm 依赖。Vue 3 和 CloudBase SDK 都通过 CDN 引入。

---

## 一、前置准备（一次性）

### 1. 创建 CloudBase 环境

打开 [云开发控制台](https://console.cloud.tencent.com/tcb)，创建一个环境（按量计费，个人用基本在免费额度内）。

创建完成后，在「环境 → 环境概览」复制 **环境 ID**（形如 `p5-1a2b3c4d`，不是环境名称）。

### 2. 创建数据库集合

控制台 →「数据库」→ 新建集合，集合名：**`settings`**

### 3. 设置集合权限

选中 `settings` 集合 →「权限设置」→ 选择 **「所有用户可读，所有用户可写」**。

> ⚠️ 这是 0.1 为了快速验证链路的临时宽松设置。1.0 会换成 `writeToken` 软门禁方案（见架构文档第五节），届时收紧。

### 4. 配置 WEB 安全域名

控制台 →「环境 → 安全配置 → WEB 安全域名」，添加：

- `localhost`（本地调试用）
- 部署后 CloudBase 分配的默认域名（部署完第一步后再加也行）

> 如果页面报跨域 / 权限类错误，多半是这里没配。

---

## 二、填写配置

复制配置模板并填入环境 ID：

```bash
cp js/config.example.js js/config.js
```

编辑 `js/config.js`：

```js
window.APP_CONFIG = {
  envId: "p5-1a2b3c4d",   // 换成你的环境 ID
  region: "ap-shanghai"   // 与环境实际地域一致
};
```

`.gitignore` 已忽略 `js/config.js`，不会提交到仓库。

---

## 三、本地运行

需要起一个本地 HTTP 服务（直接双击 `index.html` 用 `file://` 打开会有跨域问题）：

```bash
npx serve .
# 或者
python -m http.server 5173
```

浏览器打开 `http://localhost:5173`，应看到 `hello (未设置)`。在输入框里填 `p5` 并保存，页面变成 `hello p5`；刷新页面确认数据已存进 CloudBase。

---

## 四、一键部署

安装 CloudBase CLI（一次性）：

```bash
npm i -g @cloudbase/cli
```

登录（一次性，会打开浏览器授权）：

```bash
tcb login
```

部署（每次改动后执行）：

```bash
tcb hosting deploy . -e <你的环境id> --ignore "docs,.git,*.md,.gitignore,js/config.js"
```

> `tcb hosting deploy` 是纯上传，不跑构建。因为这个项目无构建步骤，直接上传源文件即可。
>
> `--ignore` 排除不需要上线的文件：设计文档、git 元数据、以及**敏感的 `js/config.js`**。

部署完成后，控制台「静态网站托管」会给出访问域名（形如 `xxx.tcloudbaseapp.com`）。把这个域名加到第 4 步的 WEB 安全域名里，然后访问验证。

---

## 五、验收标准

- [ ] 本地 `hello p5` 正常显示
- [ ] 改输入框 → 保存 → 刷新页面，值仍然是新的
- [ ] 部署后的线上地址同样工作
- [ ] `js/config.js` 没有被提交到 GitHub（`git status` 看不到它）

四条都过，0.1 就算通了。之后开始往里填 1.0 的页面。

---

## 常见问题

**页面显示「未配置 envId」**
没创建 `js/config.js`，或者 `envId` 还是空字符串。

**页面显示「CloudBase SDK 未加载」**
CDN 没加载出来，检查网络，或把 SDK 下载到 `js/vendor/` 本地引用。

**读不到数据但也没报错**
检查 `settings` 集合是否存在、里面是否有 `_id: 'app'` 的文档、集合权限是否正确。

**报跨域或 permission denied**
检查第 4 步的 WEB 安全域名是否包含了当前访问域名。

# P5

一本摄影参考手册（人像为主）：攒案例、AI 标好档位和技巧，以后拍照前翻。

当前版本 0.19b。**进度和规划只在 [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md) 的进度表里维护**，这里不重复一份。

## 跑起来

```bash
python -m http.server 5173     # 本地预览（file:// 有跨域问题，必须走 HTTP）
./deploy.sh                    # 部署
node js/facets.test.js         # 校验维度字典 / 提示词 / 解析器，零依赖、不用装东西
```

- `js/config.js` 不入库。新机器补一份：
  `cp js/config.example.js js/config.js`，再填 `envId` / `accessKey`
- 部署**只能用 `./deploy.sh`**：CLI 直传会把只读的 `.git` 一起扫，报
  `Path has no read/write permissions`；脚本是先拷到临时目录再上传
- `accessKey` 是 Publishable Key，只标识应用、放前端是安全的（门禁在服务端 Origin 校验 + RLS）；
  **别放 SecretKey**——那是 `service_role`，会绕过 RLS
- 换台电脑：`git clone` → 补 `config.js` → `npm i -g @cloudbase/cli && tcb login`（只在要部署时才装）

## 账号

**不开放注册**，命令行创建（`<envId>` = `p5-d4g6dukvb86de1377`）：

```bash
tcb user create <用户名> --password <密码> --nickname <显示名> \
  --type externalUser -e <envId>
tcb user list -e <envId>                              # 看账号，拿 <uid>
tcb user update <uid> --password <新密码> -e <envId>   # 忘记密码只能这样重置
```

控制台：云开发控制台 → 选环境 → 「身份认证 → 用户管理」。

## 出问题先看这里

| 现象 | 原因 |
|------|------|
| 页面报「未配置 envId / accessKey」 | `js/config.js` 没创建，或值还是空的 |
| 登录报 `PROVIDER_NOT_ENABLED` | 控制台「身份认证 → 登录方式」里没开「用户名密码登录」 |
| 登录一直说用户名或密码不正确 | 用 `tcb user list` 核对；密码忘了按上面「账号」里的办法重置 |
| 登录成功但刷新又回登录页 | `localStorage` 被清（隐私模式、手动清理） |
| `van-*` 组件一个都不显示，控制台没报错 | 页面脚本漏了 `app.use(vant)` |
| 写了几个表单字段，只渲染出一个 | 用了自闭合 `<van-field />`，改成 `<van-field></van-field>` |
| 改 `--van-*` 变量不生效 | `<link>` 顺序反了，`css/style.css` 必须在 Vant 的 `index.css` 之后 |
| 照片卡片整块透明、控制台没报错 | 错峰入场的 `--i` 传成了字符串，`animation` 整条失效停在 `opacity:0`。见 DESIGN.md §6.2 |
| 上传报 `STORAGE_BUCKET_NOT_FOUND` / `STORAGE_PERMISSION_DENIED` | `photos` 桶或 `storage.objects` 的 RLS 没建；确认迁移已执行 |
| 列表里某张显示「图片暂时取不到」 | 临时签名链接（1 小时）过期或生成失败，刷新即可 |
| 报 403 / CORS | 访问域名不在环境安全域名白名单里 |
| 页面是旧的 | CDN 缓存，强刷 Ctrl+Shift+R |

## 结构与文档

代码结构、脚本引入顺序、Vant 的三条硬约定（`app.use(vant)` 不能漏 / `van-*` 要完整闭合 /
`style.css` 排在 Vant 之后）都在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §七、§8.2。
**外部依赖全走 CDN，无 npm、无构建**：Vue 3、Vant 4、browser-image-compression、CloudBase JS SDK。

- [docs/PRODUCT-1.0.md](docs/PRODUCT-1.0.md) —— 产品定位、字段语义、进度表
- [docs/PROMPT.md](docs/PROMPT.md) —— AI 分析用的提示词（权威来源）与设计理由
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 技术选型、数据模型、安全模型、部署、环境实测
- [docs/DESIGN.md](docs/DESIGN.md) —— 视觉规范。**改样式先看它**：配色只有一个来源（`:root`），硬编码颜色会破坏换主题

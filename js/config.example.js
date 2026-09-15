/**
 * 配置模板（入库）
 *
 * 使用方法：复制本文件为 config.js，填入你的 CloudBase 环境 ID 和 Publishable Key。
 * config.js 已被 .gitignore 忽略，不会提交到仓库。
 *
 * 类比 Java：config.example.js ≈ application.yml，config.js ≈ application-local.yml
 */
window.APP_CONFIG = {
  // 必填：CloudBase 环境 ID，在云开发控制台「环境 -> 环境概览」可查
  // 新版环境形如 p5-xxxxxxxxxxxx，旧版形如 env-xxxxxxxx
  envId: "your-env-id",

  /**
   * 必填：Publishable Key
   *
   * CloudBase PG 环境从浏览器访问数据库需要它。控制台「环境 -> API Key」可查，
   * 或用 CLI 创建：tcb api tcb CreateApiKey --body '{"EnvId":"<envId>","KeyType":"publish_key"}'
   *
   * 按设计可放前端（只标识应用，权限由服务端 Origin 校验 + 数据库 RLS 决定）。
   * 切记：不要和 API Key / SecretKey 混淆，那类密钥只能留在服务端。
   */
  accessKey: "your-publishable-key"

  // 地域：新版 CloudBase 环境不需要填（SDK 自动解析）。
  // 仅当使用旧版 env-xxx 格式环境且请求失败时，才需要指定，如 "ap-shanghai"。
  // region: "ap-shanghai"
};

/**
 * CloudBase 封装 —— 0.5 版（登录 + 照片存取 + 删除）
 *
 * 职责：
 *   1. 初始化 SDK
 *   2. 登录 / 退出 / 查当前用户
 *   3. 照片：上传到私有桶、落库、列出自己的照片、换取临时访问链接、删除
 *
 * 依赖：
 *   - cloudbase.full.js（页面通过 CDN 引入，全局变量 cloudbase）
 *   - config.js（window.APP_CONFIG.envId / .accessKey）
 *
 * 对外接口（window.P5）：
 *   signIn(username, password)  → user          登录，失败抛异常
 *   signOut()                   → void          退出登录
 *   getCurrentUser()            → user | null   查当前登录用户（未登录返回 null）
 *   uploadPhoto(file, ext)      → path          上传照片，返回桶内路径
 *   createPhoto(meta)           → row           落库
 *   listPhotos()                → rows          当前用户的照片列表
 *   signPhotoUrls(paths)        → {path: url}   批量换临时访问链接
 *   deletePhoto(id, path)       → void          删除记录 + 桶里的文件（先删行再删文件）
 *
 * 数据库是 PostgreSQL 模式，用 app.rdb()（postgREST 风格），不是 NoSQL 的
 * app.database()。方法名不一样，别混：
 *   .where({...}) → .eq('col', v) / .match({...})
 *   .orderBy(...) → .order(...)
 *   .count()      → .select('*', { count: 'exact' })
 *   .offset(n)    → .range(from, to)
 *
 * 存储同样是 PG 模式，要用 app.storage.from('桶名').upload(...)；
 * 旧 NoSQL 的 app.uploadFile() / app.getTempFileURL() 在这里不适用。
 *
 * 安全（三层，策略都写在迁移里）：
 *   第一层 数据表 —— photo_notes 的 RLS 是 owner_id = auth.uid()，且只授
 *     authenticated。所以 listPhotos() 不传、也传不了 owner_id，由数据库过滤。
 *   第二层 照片文件 —— 桶是私有的，storage.objects 的 RLS 要求对象路径首段
 *     等于本人 uid；读取一律走临时签名 URL，不发直链。
 *   第三层 删除 —— 两道门都是 DELETE 策略 + 同样的归属判据（0.5 补上）：
 *     行只能删自己的、文件也只能删自己的。
 *
 * 会话持久化：
 *   auth({ persistence: "local" }) 会把会话存进 localStorage，
 *   所以刷新页面、关掉标签页再打开，登录态都还在。
 */
(function () {
  var PHOTO_BUCKET = "photos";
  var SIGNED_URL_TTL = 3600; // 临时链接有效期（秒）

  var app = null;
  var auth = null;
  var db = null;
  var storage = null;
  var readyPromise = null;

  function init() {
    if (readyPromise) return readyPromise;

    readyPromise = (async function () {
      var cfg = window.APP_CONFIG || {};

      if (!cfg.envId) {
        throw new Error(
          "未配置 envId：请复制 js/config.example.js 为 js/config.js，并填入 CloudBase 环境 ID"
        );
      }
      if (!cfg.accessKey) {
        throw new Error(
          "未配置 accessKey（Publishable Key）：CloudBase PG 环境从浏览器访问需要它"
        );
      }
      if (typeof cloudbase === "undefined") {
        throw new Error("CloudBase SDK 未加载，请检查网络或 CDN 地址");
      }

      // 地域：新版 CloudBase 环境由 SDK 自动解析，通常不传 region。
      // 仅旧版 env-xxx 环境请求失败时，才需要在 config.js 里显式指定。
      var initOptions = { env: cfg.envId, accessKey: cfg.accessKey };
      if (cfg.region) initOptions.region = cfg.region;

      app = cloudbase.init(initOptions);
      auth = app.auth({ persistence: "local" });
      db = app.rdb();
      // SDK 里 app.storage 是属性；万一某个版本做成方法，这里兼容一下
      storage = typeof app.storage === "function" ? app.storage() : app.storage;

      return app;
    })();

    return readyPromise;
  }

  /** 统一拆 SDK 的返回值：错误统一抛，成功原样返回（调用方自己取 .data） */
  function unwrap(res, action) {
    if (res && res.error) {
      var e = res.error;
      throw new Error(
        action + " 失败：" + (e.message || e.code || JSON.stringify(e))
      );
    }
    return res;
  }

  /** 把 SDK 返回的英文错误转成能看懂的中文 */
  function friendly(err) {
    var raw = (err && (err.message || err.error_description || err.code)) || "";
    console.warn("[P5] 登录失败原始错误:", err);

    if (/invalid.*(credential|password|login)|incorrect|wrong password/i.test(raw)) {
      return "用户名或密码不正确";
    }
    if (/user.*not.*found|no such user/i.test(raw)) {
      return "用户名或密码不正确";
    }
    if (/too many|rate.?limit|frequent/i.test(raw)) {
      return "尝试过于频繁，请稍后再试";
    }
    if (/network|fetch|timeout|Failed to fetch/i.test(raw)) {
      return "网络异常，请检查网络后重试";
    }
    return "登录失败：" + (raw || "未知错误");
  }

  /**
   * 登录。
   * 注意：SDK 把失败放在返回值里（不 throw），所以要自己判 error。
   */
  async function signIn(username, password) {
    await init();

    var res = await auth.signInWithPassword({
      username: username,
      password: password
    });

    if (res && res.error) {
      throw new Error(friendly(res.error));
    }
    return res.data && res.data.user;
  }

  /** 当前登录用户。未登录返回 null。 */
  async function getCurrentUser() {
    await init();

    // getLoginState() 会触发从 localStorage 恢复会话（刷新页面后靠它）。
    // 返回值形态各版本不一致，所以只当触发器用，真正的判断交给 getSession()。
    if (typeof auth.getLoginState === "function") {
      try {
        await auth.getLoginState();
      } catch (e) {
        console.warn("[P5] getLoginState 失败，继续尝试 getSession:", e);
      }
    }

    var res = await auth.getSession();
    var session = res && res.data && res.data.session;
    return session ? session.user : null;
  }

  /** 退出登录。本地会话会被清空。 */
  async function signOut() {
    await init();

    var res = await auth.signOut();
    if (res && res.error) {
      throw new Error("退出登录失败：" + (res.error.message || ""));
    }
  }

  /**
   * 当前用户的 uid。
   * 未登录直接抛错——绝不能让它返回 undefined 被拿去拼存储路径。
   */
  async function currentUid() {
    var user = await getCurrentUser();
    if (!user) throw new Error("登录状态已失效，请重新登录");
    return user.id || (user.user_metadata && user.user_metadata.uid);
  }

  /**
   * 文件名：时间戳 + 随机串。
   * PG 模式的 upload 默认 upsert=false，重名会直接失败，所以这里必须避开重名。
   */
  function newFileName(ext) {
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8) +
      "." +
      (ext || "webp")
    );
  }

  /**
   * 上传照片到私有桶，路径 {uid}/{文件名}。
   * 首段的 uid 不是装饰——storage.objects 的 RLS 就按它判定归属，
   * 换成别人的 uid 会被数据库直接拒绝。
   */
  async function uploadPhoto(file, ext) {
    await init();

    var uid = await currentUid();
    var path = uid + "/" + newFileName(ext);

    var res = await storage.from(PHOTO_BUCKET).upload(path, file);
    unwrap(res, "照片上传");

    return path;
  }

  /**
   * 落库。
   * owner_id 交给数据库默认值 auth.uid()——前端既不传，也传不了别的值。
   */
  async function createPhoto(meta) {
    await init();

    var res = unwrap(
      await db.from("photo_notes").insert({
        storage_path: meta.storagePath,
        title: meta.title || null,
        note: meta.note || null
      }),
      "保存照片"
    );

    return res.data;
  }

  /** 当前用户的照片，时间倒序。RLS 保证只会返回本人的行。 */
  async function listPhotos() {
    await init();

    var res = unwrap(
      await db
        .from("photo_notes")
        .select("id,storage_path,title,note,created_at")
        .order("created_at", { ascending: false }),
      "读取照片列表"
    );

    return (res && res.data) || [];
  }

  /**
   * 批量把桶内路径换成临时访问链接。
   * 桶是私有的，拿不到直链，所以渲染前必须先换一次。
   * 单张失败不中断整批——留空串，由页面决定怎么兜底。
   */
  async function signPhotoUrls(paths) {
    await init();

    var bucket = storage.from(PHOTO_BUCKET);
    var map = {};

    await Promise.all(
      paths.map(async function (path) {
        try {
          var res = await bucket.createSignedUrl(path, SIGNED_URL_TTL);
          var url =
            res && res.data && (res.data.fullSignedURL || res.data.signedUrl);
          map[path] = url || "";
        } catch (e) {
          console.warn("[P5] 生成临时链接失败:", path, e);
          map[path] = "";
        }
      })
    );

    return map;
  }

  /**
   * 删除一条记录 + 它在桶里的文件。
   *
   * 顺序是刻意的：**先删行，再删文件**。
   *   - 先删行：列表立刻干净。万一文件删失败，留下的只是一个看不见的孤儿
   *     （私有桶访问不到，也占不了多少空间）。
   *   - 反过来先删文件的话，一旦删行失败就会留下一条指向不存在文件的坏记录，
   *     界面上会显示成破图 —— 比孤儿文件难处理得多。
   *
   * 两层都由 RLS 把关：行只能删 owner_id = auth.uid() 的，
   * 文件只能删路径首段是自己 uid 的。
   */
  async function deletePhoto(id, storagePath) {
    await init();

    unwrap(
      await db.from("photo_notes").delete().eq("id", id),
      "删除记录"
    );

    if (!storagePath) return;

    try {
      unwrap(
        await storage.from(PHOTO_BUCKET).remove([storagePath]),
        "删除照片文件"
      );
    } catch (e) {
      // 记录已经删掉了，界面是对的。文件残留只影响空间，
      // 不该因为这个让用户以为整次删除失败、又去删一遍。
      console.warn("[P5] 记录已删，但照片文件删除失败（残留孤儿文件）:", storagePath, e);
    }
  }

  window.P5 = {
    signIn: signIn,
    signOut: signOut,
    getCurrentUser: getCurrentUser,
    uploadPhoto: uploadPhoto,
    createPhoto: createPhoto,
    listPhotos: listPhotos,
    signPhotoUrls: signPhotoUrls,
    deletePhoto: deletePhoto,
    // 1.5 之后可能会直接用到
    db: function () {
      return db;
    }
  };
})();

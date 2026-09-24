/**
 * CloudBase 封装 —— 0.19a 版（登录 + 照片存取 + 删除 + 维度档位 + AI 技巧 + 分页）
 *
 * 职责：
 *   1. 初始化 SDK
 *   2. 登录 / 退出 / 查当前用户
 *   3. 照片：上传到私有桶、落库、列出自己的照片（可分页）、换取临时访问链接、删除
 *   4. 标签：归一化、按标签筛选、统计标签用量
 *   5. AI 技巧：归一化（ai_tips 列，0.13 起写入）
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
 *   createPhoto(meta)           → row           落库（meta.tags / meta.aiTips 会先清洗）
 *   listPhotos({ tags, limit, offset })
 *                               → rows          当前用户的照片，时间倒序；
 *                                               tags 按档位数组筛（AND），
 *                                               limit / offset 分页（都可选）
 *   listTagCounts()             → [{tag,count}] 标签用量，倒序（客户端聚合，见函数注释）
 *   cleanTags(text|array)       → string[]      档位归一化（切分/去空/去重/截断，含冒号拦截）
 *   tagLimits()                 → {len,count}   档位的长度与数量上限，给界面做提示
 *   cleanTips(text|array)       → string[]      AI 技巧归一化（去空/去重/限 3 条，不截长度）
 *   tipsLimit()                 → {max}         技巧条数上限，给界面做提示
 *   signPhotoUrls(paths)        → {path: url}   批量换临时访问链接
 *   deletePhoto(id, path)       → void          删除记录 + 桶里的文件（先删行再删文件）
 *
 * 数据库是 PostgreSQL 模式，用 app.rdb()（postgREST 风格），不是 NoSQL 的
 * app.database()。方法名不一样，别混：
 *   .where({...}) → .eq('col', v) / .match({...})
 *   .orderBy(...) → .order(...)
 *   .count()      → .select('*', { count: 'exact' })
 *   .offset(n)    → .range(from, to)
 *   .includes(v)  → .contains('tags', [v])   ← 数组「包含」，见下面的标签一节
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

  /* --------------------------------------------------------------------------
   * 标签
   * -------------------------------------------------------------------------- */

  /* 0.12 起标签是「维度:值」（如 镜头:中长焦），两个上限都得按这个重新算：
     长度 12 偏紧，一被截断编码就坏了（decode 会拆出半个值），放到 16；
     数量 6 是自由标签时代的上限，现在的上界是「每个维度一个值」= 6 个基础 + AI 追加的若干，同样放到 16。 */
  var TAG_MAX_LEN = 16;   // 单个档位最长字数（含「维度:」前缀）
  var TAG_MAX_COUNT = 16; // 一张照片最多几个档位

  /* 分隔符：中英文逗号、顿号、中英文分号、空白。
     一口气打「构图,角度 光线」应该变成三个标签，而不是一个 12 字的长标签 */
  var TAG_SPLIT = /[,，、;；\s]+/;

  /* ⚠️ 必须清掉的字符：{ } [ ] ( ) " ' \
   *
   * 这不是洁癖，是硬约束。SDK 的 contains() 对数组参数是
   *   this.url.searchParams.append(col, "cs.{" + t.join(",") + "}")
   * **直接拼串、不做任何转义**。标签里一旦有 , 或 { }，拼出来的 postgREST
   * 数组字面量就是坏的 —— 轻则筛不出结果，重则语义变成另一个查询。
   * 方括号/圆括号/引号同理（postgREST 用它们做分组和转义），一并拦掉。
   * 逗号不在这里清，它在上面的 TAG_SPLIT 里已经被当分隔符切开了。 */
  var TAG_STRIP = /[{}\[\]()"'\\]/g;

  /**
   * 单个标签归一化：去 # 前缀、清危险字符、截断。空串表示这个标签不要。
   *
   * ⚠️ 冒号是「维度:值」的分隔符，**值里再出现冒号会把维度拆错**。
   * 这里保留第一个冒号（维度和值之间那个），它之后的冒号全清掉。
   * 界面产出的编码由 P5Facets.encode 保证合法，这道是防别的写入路径和手工改库。
   */
  function cleanTag(raw) {
    if (raw == null) return "";

    // # 只用于展示（界面写成 #低机位），不存进库 —— 存了以后筛选还得再脱一层
    var s = String(raw).replace(/#/g, "").replace(TAG_STRIP, "").trim();
    if (!s) return "";

    var sep = s.indexOf(":");
    if (sep > 0) s = s.slice(0, sep + 1) + s.slice(sep + 1).replace(/:/g, "");

    return s.slice(0, TAG_MAX_LEN);
  }

  /**
   * 一批标签归一化：切分 → 逐个清洗 → 去重 → 截断数量。
   *
   * 入参是数组时，**每个元素也会再切一次** —— 界面里自定义标签是整串传进来的
   * （用户可能一次打「构图,角度」），不切就会变成一个带逗号的标签。
   *
   * 去重用的 Object.create(null) 而不是 {}：标签叫 "constructor" 时
   * {} 上的原型属性会让 seen[t] 直接为真，那个标签会被静默丢掉。
   */
  function cleanTags(input) {
    var list = Array.isArray(input) ? input : [input];
    var seen = Object.create(null);
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var parts = String(list[i] == null ? "" : list[i]).split(TAG_SPLIT);

      for (var j = 0; j < parts.length; j++) {
        var t = cleanTag(parts[j]);
        if (!t || seen[t]) continue;
        seen[t] = true;
        out.push(t);
      }
    }

    return out.slice(0, TAG_MAX_COUNT);
  }

  function tagLimits() {
    return { len: TAG_MAX_LEN, count: TAG_MAX_COUNT };
  }

  /* --------------------------------------------------------------------------
   * AI 技巧（ai_tips 列，0.10 加列 / 0.13 起写入）
   * -------------------------------------------------------------------------- */

  /* 提示词里要的就是 1-3 条，多给的是它没听话，多的丢掉。
     ⚠️ 只限数量，**不截断单条长度** —— tips 是给人看的、不参与筛选，
     没有任何编码约束（对比 tags 的长度上限是被 postgREST 拼串逼出来的），
     截断只会静默丢内容，而静默正是这个项目一直避免的。 */
  var TIPS_MAX = 3;

  /**
   * 归一化一批 AI 技巧：合并空白 → 去空 → 去重 → 限数量。
   * 不做切分：一条 tips 本来就允许是完整的一句话（含逗号、顿号）。
   */
  function cleanTips(input) {
    var list = Array.isArray(input) ? input : input == null ? [] : [input];
    var seen = Object.create(null);
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var t = String(list[i] == null ? "" : list[i]).replace(/\s+/g, " ").trim();
      if (!t || seen[t]) continue;
      seen[t] = true;
      out.push(t);
    }

    return out.slice(0, TIPS_MAX);
  }

  function tipsLimit() {
    return { max: TIPS_MAX };
  }

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
   * tags / ai_tips 在这里统一过一道清洗：这是写入的唯一入口，校验放在这里就不会漏。
   */
  async function createPhoto(meta) {
    await init();

    var res = unwrap(
      await db.from("photo_notes").insert({
        storage_path: meta.storagePath,
        title: meta.title || null,
        note: meta.note || null,
        tags: cleanTags(meta.tags),
        ai_tips: cleanTips(meta.aiTips)
      }),
      "保存照片"
    );

    return res.data;
  }

  /**
   * 当前用户的照片，时间倒序。RLS 保证只会返回本人的行。
   *
   * options.tags 是「维度:值」编码的数组（0.15 分面筛选）：
   *   .contains('tags', ['镜头:中长焦','光线:逆光']) → postgREST 的 tags=cs.{镜头:中长焦,光线:逆光}
   *   → PG 的 tags @> '{镜头:中长焦,光线:逆光}' → 走 photo_notes_tags_idx（GIN）
   * 数组包含天然是 AND：选中的每个档位都得命中。单值也传数组，语义只有一种。
   *
   * options.limit / options.offset 是 0.19a 加的分页，**都可选**：
   *   不传 limit 就是「全部」，和以前完全一样（向后兼容，调用方不用一起改）。
   *   传了就落到 postgREST 的 Range 上：range(offset, offset + limit - 1)。
   *   照片攒到几十张以后，一次把全部行 + 全部临时链接拉下来在手机上很慢。
   *
   * ⚠️ 这里用 cleanTags 而不是逐个 cleanTag：
   *   cleanTag 是「已切分之后」的原子清洗，单独喂 '低机位,' 会把逗号留在里面，
   *   拼成 cs.{低机位,} 就永远筛不出东西。走 cleanTags 会先按分隔符切开，
   *   脏输入也能收敛成干净标签。传进来的值可能来自 URL，不能假设它干净。
   */
  async function listPhotos(options) {
    await init();

    var cleaned = options && options.tags ? cleanTags(options.tags) : [];

    var query = db
      .from("photo_notes")
      .select("id,storage_path,title,note,tags,ai_tips,created_at");

    if (cleaned.length) query = query.contains("tags", cleaned);

    query = query.order("created_at", { ascending: false });

    // range 放在最后：先把筛选和排序定下来，再圈范围
    var limit = options && options.limit > 0 ? Math.floor(options.limit) : 0;
    var offset = options && options.offset > 0 ? Math.floor(options.offset) : 0;
    if (limit) query = query.range(offset, offset + limit - 1);

    var res = unwrap(await query, "读取照片列表");

    return (res && res.data) || [];
  }

  /**
   * 所有标签 + 各自用量，按用量倒序（同量按字面序，保证顺序稳定）。
   *
   * 为什么在客户端数，而不是让数据库 group by：
   *   「SELECT unnest(tags) t, count(*) ... GROUP BY t」这种聚合 postgREST
   *   表达不了，要在服务端算就得开云函数或直连 SQL —— 这个项目刻意没有云函数
   *   （见 ARCHITECTURE.md 数据流一节）。
   *   个人项目量级下（几百条）只取 tags 一列也就是几 KB，客户端数一遍完全够。
   *   真到几千条再考虑换成服务端聚合，那时接口签名不用变。
   */
  async function listTagCounts() {
    await init();

    var res = unwrap(
      await db.from("photo_notes").select("tags"),
      "读取标签"
    );

    var rows = (res && res.data) || [];
    var counts = Object.create(null);

    rows.forEach(function (row) {
      var tags = (row && row.tags) || [];
      tags.forEach(function (t) {
        if (!t) return;
        counts[t] = (counts[t] || 0) + 1;
      });
    });

    return Object.keys(counts)
      .map(function (t) {
        return { tag: t, count: counts[t] };
      })
      .sort(function (a, b) {
        return b.count - a.count || a.tag.localeCompare(b.tag, "zh");
      });
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
    listTagCounts: listTagCounts,
    cleanTags: cleanTags,
    tagLimits: tagLimits,
    cleanTips: cleanTips,
    tipsLimit: tipsLimit,
    signPhotoUrls: signPhotoUrls,
    deletePhoto: deletePhoto,
    // 1.5 之后可能会直接用到
    db: function () {
      return db;
    }
  };
})();

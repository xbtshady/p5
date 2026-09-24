/**
 * 首页（照片列表）逻辑 —— 0.18 版（分面筛选 + 顶栏菜单 + 探索区折叠）
 *
 * 流程：
 *   1. 挂载前先查会话：没登录就跳登录页
 *   2. 取当前用户的照片（RLS 只会返回本人的行，前端不传也不该传归属条件）
 *   3. 私有桶拿不到直链，渲染前批量换成临时访问链接
 *   4. 取一次档位用量，给「探索」区分组做分面筛选
 *   5. 卡片右上角可删除：二次确认后先删行、再删桶里的文件
 *   6. 点档位筛选（维度内单选、跨维度叠加），再点一次取消
 *   7. 卡片默认只露一行档位值 + 技巧条数，点日期那行原地展开详情（0.14）
 *   8. 顶栏「⋯」收「退出」；探索区默认只展开两组维度（0.17）
 *
 * 关于「刷新时闪一下」：沿用 0.1 定下的约定 —— 先把要显示的内容全部确定好，
 * 再 mount Vue。所以照片列表、临时链接、档位用量都在 mount 之前就备齐了。
 *
 * 筛选为什么一律走服务端查询，而不是在前端过滤已取回的数组：
 *   筛过一次之后手上的列表就不是全集了（只有命中的那几张），
 *   再在前端筛只会越筛越少。取消筛选时更是只能重新取。
 *   所以每次改选中项都重新查一次，语义永远一致。
 *   多值叠加靠 contains 的 AND 语义（见 cloudbase.js 的 listPhotos）。
 */
(function () {
  var boot = document.getElementById("boot");

  function bootFail(msg) {
    if (boot) boot.innerHTML = '<span class="error">' + msg + "</span>";
  }

  // CDN 偶发不可达时的兜底提示，避免永远停在「载入中…」
  if (typeof Vue === "undefined") {
    bootFail("Vue 加载失败，请检查网络后刷新");
    return;
  }

  var createApp = Vue.createApp;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var P5 = window.P5 || {};
  // 维度字典（js/facets.js）。解码 / 判断基础维度 / 取值域顺序都读它一处，
  // 页面里不另抄一份维度表
  var Facets = window.P5Facets || {};

  // 探索区折叠时露出几组维度（0.17）。两组够看出「这里能筛什么」，
  // 又不至于把第一张照片挤出首屏
  var EXPLORE_FOLD = 2;

  // Vant 的函数式组件挂在全局 vant 上（不是 Vue 插件的一部分）
  var vantLib = window.vant || {};
  var showImagePreview = vantLib.showImagePreview;
  var showConfirmDialog = vantLib.showConfirmDialog;

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** 时间戳 → 2026.09.16 */
  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "." + pad(d.getMonth() + 1) + "." + pad(d.getDate());
  }

  /**
   * 取一批照片，并换成可以进 <img src> 的临时链接。
   * tags 是选中的档位数组（空数组 = 不筛），AND 语义由服务端 contains 保证。
   */
  async function loadPhotos(tags) {
    var rows = await P5.listPhotos(tags && tags.length ? { tags: tags } : null);

    var paths = rows
      .map(function (r) {
        return r.storage_path;
      })
      .filter(Boolean);

    // 私有桶不发直链，必须先换临时访问链接才能进 <img src>
    var urlMap = paths.length ? await P5.signPhotoUrls(paths) : {};

    return rows.map(function (r) {
      var tips = r.ai_tips || [];

      // 档位一行只显值：库里存的是「镜头:中长焦」，decode 之后只取值。
      // 「不确定」不显示 —— 它是 AI 拿不准时的合法出口，但没有参考价值，
      // 一行档位要留给真信息（展开区同规则，两处同一个数组）。
      var facetValues = P5Facets.fromTags(r.tags || [])
        .map(function (d) {
          return d.value === P5Facets.UNCERTAIN ? "" : d.value;
        })
        .filter(Boolean);

      return {
        id: r.id,
        // 删除时要连桶里的文件一起删，所以路径必须留着
        storagePath: r.storage_path,
        title: r.title || "",
        note: r.note || "",
        facetValues: facetValues,
        tips: tips,
        // 没有描述、档位、技巧任何一样时，展开区是空的 —— 不渲染那个按钮
        expandable: !!(r.note || facetValues.length || tips.length),
        open: false,
        date: fmtDate(r.created_at),
        url: urlMap[r.storage_path] || "",
        // 图片解码完置 true，CSS 靠它把照片淡出来
        loaded: false
      };
    });
  }

  async function bootstrap() {
    var user = null;
    var error = "";

    try {
      user = await P5.getCurrentUser();
    } catch (e) {
      error = e.message || String(e);
    }

    if (!user) {
      // 未登录，或会话已失效 —— 回登录页
      location.replace("login.html");
      return;
    }

    var photos = [];
    var tagCounts = [];

    if (!error) {
      try {
        photos = await loadPhotos([]);
        tagCounts = await P5.listTagCounts();
      } catch (e) {
        error = e.message || String(e);
      }
    }

    createApp({
      setup: function () {
        // 渲染用的列表。删除要就地改它，所以外面那个 photos 数组只当初始数据源
        var list = ref(photos);
        // 档位用量（扁平的 {tag,count}），给分面分组当原料
        var counts = ref(tagCounts);
        // 当前选中的档位（编码后的「维度:值」数组），空 = 没筛。
        // 同一维度最多占一项 —— 维度内单选由 filterBy 保证
        var activeTags = ref([]);
        var busy = ref(false);
        var err = ref(error);

        // 顶栏滚动阴影（class 挂在 .topbar 上，样式在 style.css）。
        // passive 监听 + 只在跨过阈值时赋值，避免每滚一帧都触发一次渲染
        var scrolled = ref(false);

        function onScroll() {
          var v = window.scrollY > 4;
          if (v !== scrolled.value) scrolled.value = v;
        }

        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();

        // 顶栏「⋯」菜单（0.17）。点别处或按 Esc 收起 —— 只靠再点一次按钮会留下
        // 一个悬空的面板，在手机上是明显的「没关掉」
        var menuOpen = ref(false);

        function closeMenu() {
          menuOpen.value = false;
        }

        function onDocClick(e) {
          if (!menuOpen.value) return;
          if (e.target.closest && e.target.closest(".menu-wrap")) return;
          closeMenu();
        }

        function onKeydown(e) {
          if (e.key === "Escape") closeMenu();
        }

        document.addEventListener("click", onDocClick);
        document.addEventListener("keydown", onKeydown);

        // 探索区折叠状态。默认收起（只露 EXPLORE_FOLD 组）
        var exploreOpen = ref(false);

        async function logout() {
          if (busy.value) return;

          busy.value = true;
          err.value = "";

          try {
            await P5.signOut();
            // 清掉本地会话后回登录页，可以换账号
            location.replace("login.html");
          } catch (e) {
            err.value = e.message || String(e);
            busy.value = false;
          }
        }

        /**
         * 点图全屏看 —— 交给 Vant 的 showImagePreview（自带双指缩放、左右切换）。
         *
         * 传进来的 index 是列表下标，但取不到临时链接的照片不参与预览，
         * 所以要重新数一遍它在「有图的那批」里排第几，否则点第 3 张会跳到第 2 张。
         */
        function preview(index) {
          if (typeof showImagePreview !== "function") return;

          var urls = [];
          var start = 0;

          list.value.forEach(function (p, i) {
            if (!p.url) return;
            if (i === index) start = urls.length;
            urls.push(p.url);
          });

          if (!urls.length) return;

          showImagePreview({
            images: urls,
            startPosition: start,
            closeable: true
          });
        }

        /**
         * 把扁平的用量 [{tag,count}] 折成按维度分组的面（0.15）。
         *
         * 三条规则：
         *   1. **基础维度按字典顺序在前，AI 追加的按用量序接在后面** ——
         *      组顺序稳定，扫的时候不用每次重新找「镜头」在哪
         *   2. 基础维度**组内的值按值域顺序**（和新增页的候选一致），AI 维度的值按用量倒序
         *   3. **「不确定」不进筛选区**，和卡片上的显示规则同一条：它没有筛选价值。
         *      拆不出来的脏标签（旧自由标签遗留）也一并跳过 —— 点了也筛不出东西
         *
         * 只显示库里真用过的值，不把整个值域铺出来：空档位点进去永远是空列表。
         * 用量上限由「维度数 × 用过的值」天然收住，不需要标签云时代那个 TAG_CLOUD_MAX。
         */
        var facetGroups = computed(function () {
          var order = [];
          var byName = Object.create(null);

          counts.value.forEach(function (c) {
            var d = Facets.decode ? Facets.decode(c.tag) : null;
            if (!d) return;
            if (d.value === Facets.UNCERTAIN) return;

            if (!byName[d.name]) {
              byName[d.name] = [];
              order.push(d.name);
            }
            byName[d.name].push({ tag: c.tag, value: d.value, count: c.count });
          });

          function baseIndex(name) {
            var list = Facets.BASE || [];
            for (var i = 0; i < list.length; i++) {
              if (list[i].name === name) return i;
            }
            return 99;
          }

          return order
            .sort(function (a, b) {
              var ai = baseIndex(a);
              var bi = baseIndex(b);
              // 稳定排序：同为基础（或同为追加）时保持用量倒序的相对次序
              return ai - bi;
            })
            .map(function (name) {
              var values = byName[name];
              var domain = Facets.valuesOf ? Facets.valuesOf(name) : null;

              if (domain) {
                values.sort(function (a, b) {
                  var ai = domain.indexOf(a.value);
                  var bi = domain.indexOf(b.value);
                  // 值域外的值（AI 给了、人留下了的）排在最后
                  if (ai < 0) ai = domain.length + values.length;
                  if (bi < 0) bi = domain.length + values.length;
                  return ai - bi;
                });
              }

              return { name: name, values: values };
            });
        });

        /** 某个档位当前是否被选中 */
        function isActive(tag) {
          return activeTags.value.indexOf(tag) >= 0;
        }

        /**
         * 实际渲染的维度组（0.17 折叠）。
         *
         * **有筛选项在生效时一律全展开** —— 否则选中项可能落在折起来的那几组里，
         * 界面上没有地方能取消它，只能点「清除」把全部筛掉。
         */
        var visibleGroups = computed(function () {
          var all = facetGroups.value;
          if (exploreOpen.value || activeTags.value.length) return all;
          return all.slice(0, EXPLORE_FOLD);
        });

        /** 筛选态那行的文字：只显示值，和卡片一个口径 */
        var activeText = computed(function () {
          return activeTags.value
            .map(function (t) {
              var d = Facets.decode ? Facets.decode(t) : null;
              return d ? d.value : t;
            })
            .join(" + ");
        });

        /**
         * 改选中项 —— 真正干活的那个（filterBy / clearFilter 都走它）。
         *
         * ⚠️ activeTags 在查询**成功之后**才改：查询失败时界面应该保持原样，
         * 不能出现「胶囊高亮了但列表还是上一批」这种自相矛盾的状态。
         */
        async function applyFilter(next) {
          busy.value = true;
          err.value = "";

          try {
            var rows = await loadPhotos(next);
            list.value = rows;
            activeTags.value = next;
          } catch (e) {
            err.value = e.message || String(e);
          } finally {
            busy.value = false;
          }
        }

        /**
         * 点一个档位筛选（0.15）—— 维度内单选、跨维度叠加：
         *   - 点已选中的那个 = 取消这一项（开关语义）
         *   - 点同维度的另一个值 = 替换掉原来那个（「镜头」不可能同时是中长焦和广角）
         *   - 点别的维度 = 叠加一项，结果是同时满足（AND）
         */
        async function filterBy(tag) {
          if (busy.value) return;

          var d = Facets.decode ? Facets.decode(tag) : null;
          var picked = isActive(tag);

          var next = activeTags.value.filter(function (t) {
            if (t === tag) return false;
            var td = Facets.decode ? Facets.decode(t) : null;
            return !(td && d && td.name === d.name);
          });

          if (!picked) next.push(tag);

          await applyFilter(next);
        }

        /** 清除全部筛选 */
        async function clearFilter() {
          if (busy.value || !activeTags.value.length) return;
          await applyFilter([]);
        }

        /**
         * 卡片原地展开 / 收起（0.14）。
         * 只改这一条的 open，别的卡片不动 —— 刷的时候一张一张看，不该连带。
         */
        function toggle(p) {
          p.open = !p.open;
        }

        /**
         * 删除一条记录。
         *
         * 先弹确认：删掉就没了，不给自己留后悔的余地。
         * 确认后交给 P5.deletePhoto（先删行再删文件，两道门都由 RLS 把关），
         * 成功了才从列表里摘掉这一条 —— 失败就原地保留并把原因显示出来。
         */
        async function remove(p) {
          if (busy.value) return;

          if (typeof showConfirmDialog === "function") {
            try {
              // 危险动作按全站约定用 --danger 那支红。
              // 从 CSS 变量读，不抄一份色值 —— 抄了就是两处维护，换主题时必漏一边。
              var dangerColor =
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--danger")
                  .trim() || "#bc331c";

              await showConfirmDialog({
                title: "删除这张照片？",
                message: "照片和记录都会删掉，无法恢复。",
                confirmButtonText: "删除",
                confirmButtonColor: dangerColor
              });
            } catch (e) {
              return; // 点了取消
            }
          }

          busy.value = true;
          err.value = "";

          try {
            await P5.deletePhoto(p.id, p.storagePath);
            list.value = list.value.filter(function (x) {
              return x.id !== p.id;
            });

            // 档位用量跟着变了，重取一次。不取的话，删掉最后一张中长焦的照片后，
            // 探索区那组里还挂着「1」，点进去却是空的。
            try {
              counts.value = await P5.listTagCounts();
            } catch (ce) {
              // 只是个数字没更新，不影响用 —— 不值得让整次删除显示成失败
              console.warn("[P5] 删除后刷新档位用量失败:", ce);
            }
          } catch (e) {
            err.value = e.message || String(e);
          } finally {
            busy.value = false;
          }
        }

        return {
          photos: list,
          facetGroups: facetGroups,
          visibleGroups: visibleGroups,
          exploreFold: EXPLORE_FOLD,
          exploreOpen: exploreOpen,
          activeTags: activeTags,
          activeText: activeText,
          isActive: isActive,
          menuOpen: menuOpen,
          busy: busy,
          error: err,
          scrolled: scrolled,
          logout: logout,
          preview: preview,
          filterBy: filterBy,
          clearFilter: clearFilter,
          toggle: toggle,
          remove: remove
        };
      }
    }).mount("#app");

    // 挂载完成（v-cloak 已移除），撤掉启动占位层
    if (boot) boot.remove();
  }

  bootstrap();
})();

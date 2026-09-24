# P5 前端设计文档

版本：0.18
最后更新：2026-09-24

本文档只写两件事：**改了会出事的硬规则**，和**踩过的坑**。
技术选型见 [ARCHITECTURE.md](ARCHITECTURE.md)，产品范围见 [PRODUCT-1.0.md](PRODUCT-1.0.md)。

---

## 一、配色

所有颜色定义在 `css/style.css` 的 `:root`，**改主题只改这一处**。Vant 的语义色也指回这些变量。

```css
:root {
  --bg: #fbfaf8;              /* 暖白纸色页面底 */
  --card: #ffffff;            /* 不透明白：输入框、卡片 */
  --chip: #f1f0ed;            /* 未选中胶囊底 */
  --skeleton: #f0efec;        /* 图片未解码占位 */
  --text: #17181a;            /* 正文（纸白底 17.6:1） */
  --muted: #6b6f76;           /* 次要文字（4.84:1） */
  --accent: #17181a;          /* 主色：近黑 */
  --accent-ink: #2c2f33;      /* 主色按下 / hover */
  --danger: #b3382a;        /* 破坏性动作（5.73:1） */
}
```

**界面只取中性色**，因为照片颜色不可控 —— 给界面染任何色调都会和照片打架。
主色是近黑（不是彩色），所以全站唯一有颜色的东西就是照片。

**两级文字色 + 三级字号**（16 / 13 / 11px）。不要在 `--text` 和 `--muted` 之间再加一档：
符合 WCAG 的第三级灰对比度只有 2.46:1，白底上读不清。

**不许硬编码颜色。** 除 `:root` 外只能出现 `var(...)` 和 `currentColor`。
只有两种字面量例外（ unavoidable）：`#ffffff`（主按钮 / 选中胶囊上的白字）、`rgba(255,255,255,0.72)`（选中标签里的计数）。
改完跑一次：

```bash
grep -n -E "#[0-9a-fA-F]{3,8}|rgba?\(" css/style.css | grep -v ":root"
```

**对比度**：正文 ≥ 7:1，次要文字与按钮 ≥ 4.5:1。当前（纸白底）正文 17.6:1、次要文字 4.84:1、危险色 5.73:1。
改配色后必须重算，不能靠眼睛判断。

---

## 二、层次分隔：留白 + 细节线，不是磨砂和阴影

0.16 起把 0.6 那套磨砂玻璃（`backdrop-filter`、`--glass`、光斑层、大阴影）整体作废。
现在层次只靠三样东西：

1. **页面底是暖白纸色**（`--bg: #fbfaf8`），卡片用纯白（`--card: #ffffff`），照片压在纸白上就是主角
2. **细节线**（`--border: rgba(23,24,26,0.1)`）—— 输入框轮廓、展开区分隔、顶栏滚动后下边界
3. **字号 / 字重 / 字距**拉开层级 —— 标题 16px / 500、档位行 13px、日期计数 11px；小节标签大字距小字号

### 2.1 列表页去 body padding

`.page-list` 的 `body` 不再给 `padding: 24px`，而是 `padding: 0; align-items: flex-start;`。
照片要**全出血**贴到屏幕边，左右内边距由需要留白的文字块自己管：

- `.explore { margin: 0 var(--gutter) 22px; }`
- `.shot-body { padding: 12px var(--gutter) 0; }`
- `.feed-wrap` 本身 `padding: 0`

其它页（create / login）仍保留 body padding，用来把表单 / 登录卡居中。

**这是磨砂最容易做错的地方。** 毛玻璃只是模糊它背后的内容；背后若是一片纯色或一层光滑渐变，
模糊完还是那个样子。

0.6 第一版就是「代码全对、肉眼零效果」，三处都做错了：

| 做错了 | 结果 |
|--------|------|
| 光斑太淡（只比底色亮 5%） | 糊完还是同一个色 |
| 只有光滑渐变、没有可辨认的边缘 | 模糊前后都是那层渐变 |
| 卡片太实（0.72–0.86 的白） | 把背后的东西整个盖掉了 |

**要满足三条才看得出来：**

1. **底色和光斑有落差** —— 现在底 `#d7dbe2`、光斑最亮到纯白，落差约 22%
2. **光斑有形状边界** —— 卡片压过光斑边缘时，边缘被糊开的一段就是能看到的磨砂
3. **卡片够透** —— `--glass` 是 `0.55`（试过 0.72，和纯白卡分不出来）

层挂在 `html::before`（fixed）上，**不要挂 `body::before`**：
`body` 上的不透明底色会让它成为内部 fixed 伪元素的**包含块**，`fixed` 退化成「固定在 body 上」
跟着内容滚；`body` 本身在列表页也是随内容增长的高块，会露出没铺到的空白。
所以底色给 `html`（`background: var(--bg)`），`body` 保持透明。

### 2.2 圆角降一档

胶囊和按钮从满圆改成小圆角矩形（`--r-sm: 6px`、`--r-md: 8px`、`--r-lg: 10px`）。
大圆角和磨砂一起退场 —— 矩形感更「工具 / 手册」。

### 2.3 阴影只剩一处

**全站唯一一处阴影**：顶栏下拉菜单 `.menu-panel`。
它必须浮起来才读得出「在别的层」，所以保留 `box-shadow: 0 8px 24px rgba(23,24,26,0.1)`。
其它任何卡片、顶栏、按钮都不再加阴影；用 1px 细节线或纯留白分界。

### 2.4 不要再写 `backdrop-filter`

改版后若出现 `backdrop-filter` 或 `filter: blur`，说明旧的磨砂习惯回来了，直接删掉。
验证命令：

```bash
grep -n "backdrop-filter\|filter: blur\|--glass\|html::before" css/style.css
```

应当 0 命中。

---

## 三、布局

### 3.1 sticky 顶栏要靠 padding 躲开

顶栏 `sticky` 会盖住内容区开头，`.feed-wrap` 必须补上：

```css
padding-top: calc(var(--topbar-h) + env(safe-area-inset-top, 0px) + 14px);
```

`var(--topbar-h)` 现在是 56px，不要再写死数字；`.feed-wrap` 和 `.topbar` 读同一个变量。
漏了的症状：第一张照片被顶栏盖掉上沿。

### 3.2 图片上的浮层控件不能用白色圆底

浅色照片上会直接消失。删除按钮用**半透明深底 + 白色图标**（`rgba(16,18,22,.55)`）。

### 3.3 改完布局用无头 Chrome 量，不要靠感觉

三个宽度（320 / 360 / 430），指标：`scrollWidth - innerWidth === 0`（无横向溢出）、
顶栏高度和 61 对得上、删除按钮在卡片内部。

**无头 Chrome 的坑**：

- `--headless=new` 下 `--window-size` 对页面宽度无效（恒约 500px），但 `--headless=old` 尊重 `--window-size`。
- 本沙箱把 Chrome 的 `--dump-dom` / `--enable-logging=stderr` 输出全吃掉，所以没法用 DOM 回传或 console 读数。
  做法是：**iframe 里量，父页把结果渲染成文本，再截整张图读回来**。
- iframe 不要放到屏幕外：Chrome 会优化掉离屏 iframe 的渲染，导致量到的元素数量不全。

---

## 四、动效

只有两条入场动画：`rise`（卡片浮上来 + 淡入）、`develop`（图片从 0.35 透明度「显影」）。
时长 120–240ms。**只在元素出现时跑一次**，不循环、不呼吸。

- 触屏上不绑 hover（外面套 `@media (hover: hover)`）—— 手机上 hover 会「粘住」不消失
- `transition` 只写具体属性，不写 `all`
- `develop` 从 0.35 而不是 0 开始：起点全透明会在那一帧闪出底色

### 4.1 `prefers-reduced-motion` 压时长，不要 `animation: none`

压到 `0.001ms` 能保留终态；`animation: none` 会让 `animation-fill-mode: both` 失效，
元素停在 `rise` 的起始帧（`opacity: 0`）—— **整页空白**。

### 4.2 ⚠️ 错峰入场的 `--i` 必须是数字

列表卡片的入场延时是 `calc(var(--i, 0) * 50ms)`。

模板传 `:style="{ '--i': 6 }"`（数字）没问题；**传字符串 `'6'` 会让 `calc('6' * 50ms)` 非法**，
而 `animation-delay` 一旦非法，**同一规则里的 `animation` 简写会一起失效** ——
动画不跑，元素停在 `rise` 的 `from` 帧。

**症状：卡片全透明，控制台一声不吭。** 栽过一次（改配色后截图发现整个列表是空的）。

两道防护都要留着：

1. 模板传数字（Vue 对数字不加引号；字符串会被原样写进 `style`）
2. CSS 里 `animation-delay` **写成独立属性**，不并入 `animation` 简写 —— 最坏只丢延时，不丢整条动画

---

## 五、Vant 4 的四条硬约定

组件库只负责**控件**，不负责**壳**（输入框、上传、看图、确认框用它；卡片、顶栏、按钮视觉自己写）。

下面几条**都会静默失败**，改任何页面前先记住：

1. `css/style.css` 的 `<link>` 必须在 Vant `index.css` **之后**，否则 `--van-*` 覆盖被默认值盖掉
2. 页面脚本里 `app.use(vant)` 一步不能漏，漏了组件渲染不出来且不报错
3. 所有 `van-*` 写**完整闭合标签**，`<van-field />` 会吞掉后面所有同级组件
4. `van-field` 上传的 `aria-*` 等未声明属性落到**外层 div**，内部 `<input>` 拿不到
   （它只转发 `placeholder` / `autocomplete` 这类声明过的 prop）。所以需要真正的
   无障碍标签时别用 van-field —— 它的 label 渲染的是 `<div>`，做不了 label→input
   的关联；改用原生 `<input>` + `<label for>`（见登录页 `.sr-only`）

> 确认弹窗的按钮颜色写在 JS 里（`confirmButtonColor`），是全站唯一一处颜色值不在 CSS 的地方 ——
> 改 `--danger` 时这里要跟着改。

---

## 六、改样式的流程

1. 只改 `:root` —— 要改颜色先试变量，动不了再改具体规则
2. 检查没有磨砂痕迹：
   ```bash
   grep -n "backdrop-filter\|filter: blur\|--glass\|html::before" css/style.css
   ```
   应当 0 命中。
3. 检查没有新硬编码颜色：
   ```bash
   grep -n -E "#[0-9a-fA-F]{3,8}|rgba?\(" css/style.css | grep -v ":root"
   ```
   只保留 `#ffffff` / `rgba(255,255,255,0.72)` 两处例外。
4. 无头 Chrome 量 320 / 360 / 430 三档：指标是 `scrollWidth - clientWidth === 0`
   （无横向溢出）、顶栏高 56px、第一张照片从顶栏下方开始。
   做法见 §3.3：用 iframe 钉宽度，父页汇总结果并截图读回。
5. **实际截图看一眼** —— 只量数值会漏掉「卡片全透明」这类事
6. 大括号配平：`python -c "s=open('css/style.css',encoding='utf-8').read(); print(s.count('{'), s.count('}'))"`
7. 临时预览页用完就删，`git status --short` 必须干净

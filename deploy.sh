#!/usr/bin/env bash
#
# P5 部署脚本 —— 把站点文件上传到 CloudBase 静态托管
#
# 用法：
#   ./deploy.sh
#   TCB_ENV_ID=xxx ./deploy.sh        # 临时指定其它环境
#
# 为什么不用 `tcb hosting deploy .`：
#   直接传整个项目目录时，CLI 会连 `.git/` 一起扫。git 对象文件是只读（444）的，
#   而 CLI 的权限检查要求可写，于是报 "Path has no read/write permissions" 直接中断。
#   `--ignore` 试过 `.git`、`.git/`、`.git/**` 等写法都拦不住那个预扫描。
#   所以这里改成：只把要上线的文件复制到一个临时目录，再从那里部署。
#
# 关于 js/config.js：
#   它必须上传 —— 页面要靠里面的 envId 和 publishable key 才能连数据库。
#   这两个值按设计就是公开的（真正的门禁是服务端 Origin 校验 + 数据库 RLS）。
#   将来 1.0 的写入口令不放在这里，所以 config.js 可以安全上线。
#
set -euo pipefail

ENV_ID="${TCB_ENV_ID:-p5-d4g6dukvb86de1377}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="${STAGE_DIR:-$(mktemp -d)/p5-deploy}"

command -v tcb >/dev/null 2>&1 || {
  echo "找不到 tcb 命令，请先安装：npm i -g @cloudbase/cli" >&2
  exit 1
}

echo "==> 准备发布目录: $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

cd "$ROOT"

# 页面
for f in *.html manifest.json; do
  [ -f "$f" ] && cp "$f" "$STAGE/"
done

# 静态资源目录
for d in css js icons assets; do
  [ -d "$d" ] && cp -r "$d" "$STAGE/"
done

echo "==> 待发布文件:"
( cd "$STAGE" && find . -type f | sed 's|^\./|  |' )

echo "==> 上传到环境 $ENV_ID"
tcb hosting deploy "$STAGE" -e "$ENV_ID" --verify

echo "==> 完成。访问域名见上方输出的 Deployment completed 一行。"

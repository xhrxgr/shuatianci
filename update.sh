#!/bin/bash
# =============================================================================
# 一键更新脚本（root 可直接跑，不需要 sudo / 不需要切用户）
#
# 为什么需要它
# ------------
# PHP-FPM 通常以 www 运行，在线更新要在 .git 目录里写对象文件。
# 若用 root 执行 git，检出的文件属主会变成 root，www 就写不进去了，
# 于是下次更新报：insufficient permission for adding an object。
#
# 这个脚本的做法是**让 git 全程以 www 的身份跑**，而不是「用 root 跑完再补救」。
# 两种方式的差别在于：
#   · root 跑 git + 事后 chown  → 能用，但每次都要记得补一条 chown，
#     忘一次就又坏了；而且 chown -R 要遍历整个目录，大项目上很慢。
#   · 全程以 www 跑           → 文件属主从头到尾正确，无需任何补救。
#
# 之所以强调这一点：很多服务器只开了 root 登录（或没给运维账号配 sudo），
# 网上常见的「sudo -u www git ...」在那里根本执行不了。
#
# 用法
# ----
#   bash /www/wwwroot/你的项目目录/update.sh
#
# 可选：指定分支
#   bash update.sh main
# =============================================================================

set -euo pipefail

# 项目目录：本脚本所在目录
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="${1:-}"

cd "$PROJECT_DIR"

# ---- 前置检查：出问题时给一句人话，而不是把 git 的原始报错甩出去 ----------
if ! command -v git >/dev/null 2>&1; then
    echo "✗ 找不到 git 命令。请先安装（面板软件商店 → Git，或 yum install git）。" >&2
    exit 1
fi

if [ ! -d ".git" ]; then
    echo "✗ 当前目录不是 git 仓库：$PROJECT_DIR" >&2
    echo "  这个项目需要用 git 管理才能在线更新。" >&2
    echo "  请确认路径是否正确，或参考 README「让项目支持在线更新」一节初始化。" >&2
    exit 1
fi

# ---- 探测 PHP 的运行用户 --------------------------------------------------------
# 取自 php-fpm 的配置（宝塔路径形如 /www/server/php/82/etc/php-fpm.conf）。
# 拿不到就用 www —— 绝大多数宝塔环境都是它。
detect_php_user() {
    local user=""

    # 1) php-fpm 进程的实际运行用户（最准）
    if command -v ps >/dev/null 2>&1; then
        user="$(ps -eo user,args 2>/dev/null \
               | grep -E 'php-fpm' | grep -v grep \
               | awk '{print $1}' | head -n1 || true)"
    fi

    # 2) 退回到宝塔 php-fpm.conf 里的 www.conf
    if [ -z "$user" ] || [ "$user" = "root" ]; then
        for conf in /www/server/php/*/etc/php-fpm.conf /usr/local/etc/php-fpm.conf /etc/php-fpm.conf; do
            if [ -f "$conf" ]; then
                local pool
                pool="$(grep -oE '^\s*www\.conf\s*$' "$conf" | tr -d '[:space:]' || true)"
                if [ -n "$pool" ]; then
                    local dir
                    dir="$(dirname "$conf")/$pool"
                    [ -f "$dir" ] && pool="$dir"
                fi
                if [ -f "$pool" ]; then
                    local u
                    u="$(grep -oE '^[[:space:]]*user[[:space:]]*=[[:space:]]*\S+' "$pool" 2>/dev/null \
                         | head -n1 | sed -E 's/.*=[[:space:]]*//' || true)"
                    [ -n "$u" ] && [ "$u" != "root" ] && user="$u" && break
                fi
            fi
        done
    fi

    # 3) 该用户存在吗
    if [ -n "$user" ] && id "$user" >/dev/null 2>&1; then
        echo "$user"
        return 0
    fi
    # 4) 常见候选
    for candidate in www nginx apache httpd; do
        if id "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    echo ""
}

PHP_USER="$(detect_php_user || true)"

if [ "$(id -u)" -ne 0 ]; then
    # 不是 root：本来就可以用自己的身份跑，直接执行即可
    echo "当前用户：$(id -un)（非root，直接执行 git）"
    exec git fetch origin --prune
    exec git reset --hard "origin/${BRANCH:-master}"
fi

echo "当前用户：root"
echo "PHP 运行用户：${PHP_USER:-未探测到}"

# ---- 以 PHP 用户身份执行 git --------------------------------------------------
# 依次尝试 runuser / su，两者都是 util-linux 自带的，**不需要 sudo、不需要
# /etc/sudoers 配置** —— 这正是本脚本存在的意义（很多服务器只开root 登录）。
run_as_php_user() {
    if [ -z "$PHP_USER" ]; then
        return 1
    fi
    if command -v runuser >/dev/null 2>&1; then
        runuser -u "$PHP_USER" -- git "$@"
        return $?
    fi
    if command -v su >/dev/null 2>&1; then
        su -s /bin/bash "$PHP_USER" -c "cd \"$PROJECT_DIR\" && git $*"
        return $?
    fi
    return 1
}

TARGET="origin/${BRANCH:-master}"

# 注意：set -e 下「函数返回非 0」会直接终止脚本，走不到下面的兜底分支。
# 所以这里显式允许失败（`|| true`），由 if 来判断该走哪条路。
if run_as_php_user fetch origin --prune || true; then
    echo "拉取完成（以 $PHP_USER 身份）"
    if run_as_php_user reset --hard "$TARGET"; then
        echo "更新完成：$TARGET"
        echo "属主全程正确，无需 chown。"
        exit 0
    fi
    echo "reset 失败，请手动执行：git -C $PROJECT_DIR reset --hard $TARGET" >&2
    exit 1
fi

# ---- 兜底：runuser/su 不可用时，用 root 跑并事后修复属主 --------------------
echo
echo "以 $PHP_USER 身份执行失败，改用 root 执行并在结束后修复属主……" >&2
echo "（这一步之后必须 chown，否则网页端的在线更新会报权限错误）" >&2

git fetch origin --prune
git reset --hard "$TARGET"

if [ -n "$PHP_USER" ]; then
    echo "正在把属主改回 $PHP_USER ..."
    chown -R "$PHP_USER":"$PHP_USER" "$PROJECT_DIR"
    echo "属主已修复。"
else
    echo
    echo "⚠️ 没能探测到 PHP 的运行用户，属主仍是 root。" >&2
    echo "请手工执行（把 www 换成 PHP 的实际运行用户）：" >&2
    echo "    chown -R www:www $PROJECT_DIR" >&2
fi

echo "更新完成：$TARGET"

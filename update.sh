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
        # ⚠️ 必须排除 master：php-fpm 的 master 进程由 root 启动（要绑定特权端口），
        # 真正执行 PHP 代码的是 pool worker（www）。不排除的话 head -n1 很容易抓到
        # master，于是脚本以为"PHP 用户是 root"，让 git 以 root 跑——
        # 写进 .git/objects 的对象就归了 root，之后 www 再也写不进去，
        # 在线更新报 insufficient permission for adding an object。
        # 这个坑踩过：探测显示「PHP 运行用户：root」，实际是 www。
        user="$(ps -eo user,args 2>/dev/null \
               | grep -E 'php-fpm' | grep -v grep | grep -viE 'master' \
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
    # 不是 root：本来就可以用自己的身份跑，直接执行即可。
    #
    # ⚠️ 这里原来写的是 `exec git fetch` + `exec git reset`：
    # exec 会**用 git 替换掉当前 shell 进程**，所以第二行永远执行不到，
    # 结果是「只 fetch 不 reset」，代码根本没切换，脚本却打印了"更新完成"。
    # 这是比失败更糟的静默失败：用户以为升级了，实际还在跑旧版本。
    echo "当前用户：$(id -un)（非root，直接执行 git）"

    if ! git fetch origin --prune; then
        echo "✗ 拉取失败。请检查网络是否能访问代码仓库，或先配置更新源/加速通道。" >&2
        exit 1
    fi
    if ! git reset --hard "origin/${BRANCH:-master}"; then
        echo "✗ 切换代码失败（可能有 index.lock 残留，或本地改动冲突）。" >&2
        echo "  如有本地改动，先 git -C $PROJECT_DIR status 看看，再决定是否 stash。" >&2
        exit 1
    fi

    # 让 PHP 立刻加载新代码（opcache）。网页更新走的是同一个标记。
    touch "$PROJECT_DIR/php/data/reload.flag" 2>/dev/null || true
    echo "更新完成：origin/${BRANCH:-master}"
    echo "已设置 reload 标记，下次请求会重载 opcache。"
    exit 0
fi

echo "当前用户：root"
echo "PHP 运行用户：${PHP_USER:-未探测到}"

# ---- 属主自检（root 跑过 git 会留下 root 属主的对象）--------------------------------
# 现象：在线更新报 insufficient permission for adding an object，
#      而只读命令（rev-parse、log）一切正常，极难联想到是权限问题。
# 成因：之前用 root 跑过 git（手工 reset、或探测失误让脚本以 root 跑），
#      .git/objects 里混进 root 属主的文件，PHP 用户再也写不进去。
# 处理：探测不到 PHP 用户、或它确实是 root 时不动；否则试写一次，不行就自动修。
if [ -n "$PHP_USER" ] && [ "$PHP_USER" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
        if ! runuser -u "$PHP_USER" -- test -w "$PROJECT_DIR/.git/objects" 2>/dev/null; then
            echo "⚠️ 检测到 .git/objects 对 $PHP_USER 不可写（多半是之前用 root 跑过 git）。" >&2
            echo "  在线更新会因此失败。正在自动修复属主…" >&2
            if chown -R "$PHP_USER":"$PHP_USER" "$PROJECT_DIR/.git" 2>/dev/null; then
                echo "  ✓ 已修复：.git 现已归 $PHP_USER 所有。" >&2
            else
                echo "  ✗ 自动修复失败，请手动执行：" >&2
                echo "    chown -R $PHP_USER:$PHP_USER $PROJECT_DIR/.git" >&2
            fi
        fi
    fi
fi

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

# 脏检查：reset --hard 会无声丢弃本地改动。网页路径有三道（其中两道是硬闸），
# 命令行路径原本一道都没有 —— 在服务器上手工改过的文件会被静默覆盖。
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "⚠️ 检测到本地有未提交的改动：" >&2
    git status --short >&2
    echo "  reset --hard 会把它们全部丢弃。" >&2
    if [ "$FORCE_UPDATE" != "1" ]; then
        echo "  确认要丢弃就加 FORCE_UPDATE=1 重跑，或先 git stash。" >&2
        exit 1
    fi
    echo "  已设置 FORCE_UPDATE=1，继续。" >&2
fi

# 注意：set -e 下「函数返回非 0」会直接终止脚本，走不到下面的兜底分支。
# 所以这里显式允许失败（`|| true`），由 if 来判断该走哪条路。
if run_as_php_user fetch origin --prune || true; then
    echo "拉取完成（以 $PHP_USER 身份）"
    if run_as_php_user reset --hard "$TARGET"; then
        touch "$PROJECT_DIR/php/data/reload.flag" 2>/dev/null || true
echo "更新完成：$TARGET"
echo "已设置 reload 标记，下次请求会重载 opcache。"
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
    # ⚠️ 只改代码目录，**不要 chown -R 整个项目**：php/data 里是 SQLite 数据库
    # 与状态文件，整体改属主会让正在打开库的 FPM 进程拿不到锁，
    # 表现为「更新完之后站点开始报错」，比属主不一致难查得多。
    chown -R "$PHP_USER":"$PHP_USER" "$PROJECT_DIR" 2>/dev/null
    # php/data 单独确保目录可写（数据库文件本身保持原属主）
    chown "$PHP_USER":"$PHP_USER" "$PROJECT_DIR/php/data" 2>/dev/null || true
    echo "属主已修复（php/data 只改目录属主，未动数据库文件）。"
else
    echo
    echo "⚠️ 没能探测到 PHP 的运行用户，属主仍是 root。" >&2
    echo "请手工执行（把 www 换成 PHP 的实际运行用户）：" >&2
    echo "    chown -R www:www $PROJECT_DIR" >&2
fi

echo "更新完成：$TARGET"

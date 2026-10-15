<?php
/**
 * 系统设置页。
 *
 * 与纯前端实现的两点差别（对用户无感知）：
 * - 首屏不请求接口：页面骨架由 PHP 直出，版本信息与更新状态等动态内容
 *   由 assets/js/admin-system.js 调 /api/system/* 后填充
 * - loading 用「默认展示加载文案、接口回来后切换」实现
 *
 * 所有动态文本都由 JS 输出并自行转义。
 *
 * @var string|null $guard 非空时为权限提示 HTML（未登录 / 非管理员），页面只输出它
 * @var string      $currentPath
 */
?>
<?php if ($guard !== null): ?>
  <?= $guard ?>
<?php else: ?>
  <p class="p-10 text-center text-sm text-muted" id="admin-system-loading">正在读取版本信息……</p>

  <div class="space-y-5" id="admin-system-root" hidden>
    <div>
      <h1 class="text-xl font-semibold text-ink">系统设置</h1>
      <p class="mt-1 text-sm text-muted">
        查看当前部署版本，并直接在网页上完成更新，无需登录服务器。
      </p>
    </div>

    <!-- 提示条由 feedback.js 渲染（含图标、详情、重试），容器只负责定位 -->
    <div class="space-y-2" id="admin-system-error" hidden></div>
    <div class="space-y-2" id="admin-system-notice" hidden></div>

    <!-- 当前版本 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h2 class="mb-3 text-sm font-semibold text-ink">当前版本</h2>
      <div data-version-body></div>
    </section>

    <!-- 更新源：服务器能不能直连 GitHub 因机器而异，放在这里配置，
         不用 SSH 上去敲 git config。放在「检查更新」之前——
         源没配好就去检查，失败时用户无从下手。 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h2 class="mb-1 text-sm font-semibold text-ink">更新源</h2>
      <p class="mb-4 text-xs leading-5 text-muted">
        默认直连 GitHub。若服务器连不上，可以换一个加速通道；
        改完点「测试连接」确认能拉通，再点「保存设置」。
        设置只对在线更新生效，不会改动仓库目录里的文件。
      </p>

      <div class="space-y-4">
        <div>
          <label class="mb-1.5 block text-sm font-medium text-ink" for="us-remote">仓库地址</label>
          <input
            id="us-remote"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://github.com/xhrxgr/shuatianci.git"
            class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
          >
          <p class="mt-1.5 text-xs text-muted">
            官方仓库一般不用改。换自己的仓库才需要填。
          </p>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-ink" for="us-preset">连接方式</label>
          <select
            id="us-preset"
            class="min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
          ></select>
          <p class="mt-1.5 text-xs text-muted" data-preset-hint></p>
        </div>

        <div data-custom-proxy hidden>
          <label class="mb-1.5 block text-sm font-medium text-ink" for="us-proxy">加速地址前缀</label>
          <input
            id="us-proxy"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://你的反代/https://github.com/"
            class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-primary"
          >
          <p class="mt-1.5 text-xs text-muted">
            规则：把仓库地址里 <span class="font-mono">https://github.com/</span> 这一段换成它。
            例如填 <span class="font-mono">https://gh-proxy.com/https://github.com/</span>，
            实际就会去访问 <span class="font-mono">https://gh-proxy.com/https://github.com/你的仓库</span>。
          </p>
        </div>

        <div class="rounded-lg border border-line bg-surface-alt p-3 text-xs leading-5 text-muted">
          实际会访问：
          <span class="mt-1 block break-all font-mono text-ink" data-effective-url>—</span>
        </div>

        <!-- 「配置文件里的地址」与「git 实际用的地址」不一致时显示。
             不一致意味着上面填的地址是空文：更新跑的是 git fetch origin，
             读的是 .git/config 里那个。这个提示由 JS 控制显隐。 -->
        <div
          class="rounded-lg border border-warning/40 bg-warning-soft p-3 text-xs leading-5 text-muted"
          data-remote-mismatch
          hidden
        >
          <p class="font-medium text-ink">网页上填的地址与 git 实际使用的地址不一致</p>
          <p class="mt-1">git 实际用的是：<span class="break-all font-mono" data-git-remote>—</span></p>
          <p class="mt-1">
            更新跑的是 <span class="font-mono">git fetch origin</span>，用的是上面这个地址，
            不是表单里填的那个。点「保存设置」会自动同步；若同步失败（属主问题），
            请在服务器项目目录执行
            <span class="font-mono">git remote set-url origin &lt;你要的地址&gt;</span>。
          </p>
        </div>

        <!-- 走第三方加速通道时的风险提示：代理是中间人，git 只能验证对象自洽，
             无法验证那就是 GitHub 发布的原版 -->
        <div
          class="rounded-lg border border-line bg-surface-alt p-3 text-xs leading-5 text-muted"
          data-third-party-warn
          hidden
        >
          <p class="font-medium text-ink">正在使用第三方加速通道</p>
          <p class="mt-1">
            加速通道是<strong>中间人</strong>：代码经别人的服务器转发到你的服务器。
            git 能保证取回来的内容自洽，但无法保证那就是 GitHub 发布的原版——
            代理理论上可以返回构造好的代码。
          </p>
          <p class="mt-1">
            能用直连就尽量用直连；必须用加速时，选你信得过的通道。
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            id="us-test"
            class="min-h-11 rounded-lg border border-line px-4 py-2 text-xs font-medium text-muted transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-50"
          >测试连接</button>
          <button
            type="button"
            id="us-save"
            class="min-h-11 rounded-lg bg-primary px-5 py-2 text-xs font-medium text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >保存设置</button>
          <button
            type="button"
            id="us-reset"
            class="min-h-11 rounded-lg border border-line px-4 py-2 text-xs text-muted transition hover:bg-surface-alt"
          >恢复默认</button>
        </div>
      </div>
    </section>

    <!-- 更新 -->
    <section class="rounded-xl border border-line bg-surface p-5">
      <h2 class="mb-1 text-sm font-semibold text-ink">检查更新</h2>
      <div data-update-actions></div>
      <div data-check-result></div>
    </section>

    <!-- 更新进度 -->
    <section class="rounded-xl border border-line bg-surface p-5" id="admin-system-progress" hidden>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-ink">更新进度</h2>
        <span class="text-xs text-muted" id="admin-system-stage" hidden></span>
      </div>

      <div class="max-h-72 overflow-y-auto rounded-lg border border-line bg-surface-alt p-3" id="admin-system-logs"></div>

      <p class="mt-3 text-xs text-muted" id="admin-system-updating-hint" hidden>
        更新期间请勿关闭页面（通常十几秒完成；完成后页面会自动刷新）。
      </p>

      <button
        type="button"
        data-action="reload"
        id="admin-system-reload"
        class="mt-4 min-h-11 w-full rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary transition hover:bg-primary-hover sm:w-auto"
        hidden
      >刷新页面</button>
    </section>
  </div>

  <script type="module" src="<?= e(asset_url('/js/admin-system.js')) ?>"></script>
<?php endif; ?>

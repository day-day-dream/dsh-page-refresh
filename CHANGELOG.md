# 变更记录

## 1.3.0 — 2026-11-03

关闭不再误伤邻居，失败不再黑屏九十秒。

### 修复

- **§3.1** 把线上跑过三天的 taskkill 引号修复并回仓库：进程名不加引号会被 WMI 按空格拆参，taskkill 收到的是 `/IM DeepSeek` 加 `Harness.exe /F`，匹配不到进程。
- **§3.5** 传给 `wmi-launch.ps1` 的参数按需加引号。含空格的路径（如 `C:\Users\John Doe\...`）原来会静默失败，而 WMI 的 `ReturnValue` 仍是 0 —— 那个返回值不能当作"跑起来了"。
- **§3.6** `launchHidden` 接住 `wmi-launch.ps1` 的 stdout/stderr。原来 `stdio: 'ignore'` 把 `exe=/args=/cmdline=/return=` 全丢了，失败只剩一行 `spawn-exit code=…`。
- **§3.7** 日志轮转（5MB 上限，转存 `.log.1`）；`denied` 行里的 Host 头做换行清洗。
- **§3.8** `dsh-power.ps1` 三处修正：`$before` 的统计时机（原来在 kill 之后，永远是 0）、`verify-ok` 的判据（改成"存在一个父进程不在本批里的 root 进程"，不再把 crashpad 残留算成功）、固定 `Start-Sleep 3` 换成 200ms 轮询。
- **§6.2 真机验收查出来的真 bug**：上面那三处修正当时往 `dsh-power.ps1` 里写进了中文注释，而 Windows PowerShell 5.1 读无 BOM 的 `.ps1` 是按 ANSI 解码的 —— 中文注释把后面的代码吃掉，整个脚本报 `Unexpected token '}'` 解析失败。插件调用的正是 5.1（不是 pwsh 7），所以**通用重启路径从来没有真正生效过**：点下去 API 返回 `mode=portable` 一切正常，实际没有任何进程被杀，app 原地不动。已恢复纯 ASCII，并用 5.1 真跑 `-Action probe` 验证能取到正确的 exe 与参数。
- **§3.2** 打包补齐 `screenshots.json` / `assets/` / 包内 `README.md`（`npm pack` 6 → 9 个文件）。

### 新增

- **§3.4** 关闭改为按 PID 杀进程树（`taskkill /PID <ppid> /T /F`）。原来按镜像名杀会命中所有同名进程，同时开着 desktop 与 web、或两个 desktop 实例时会一起关掉。
- **§7-2** 杀树前先用 `tasklist` 核一次父进程名，名不符就退回按名杀。这条防的是：有人手工 `set ELECTRON_RUN_AS_NODE=1` 后在终端里跑 host，此时 `process.ppid` 是那个终端，按树杀会把它一起带走。代价约 270ms，遮罩已盖住。
- **§3.3** 非 Windows 平台写端点直接回 501（原来 handler 返回 `ok:true` 后客户端要等 90 秒兜底）；客户端挂载时探一次 `/api/power/status`，非 Windows 把电源按钮置灰并注明原因。
- **§3.10** 客户端五项：`note` 换行（`pre-wrap`）、条目常驻可重试（配 `busy` 禁用防双触发）、遮罩与定时器随组件卸载清理、Esc / 方向键 / 焦点入菜单、刷新图标从字形 `↻` 换成与电源同规格的 24 网格内联 SVG。

### 已知限制

- **§6.2** 通用重启路径 `dsh-power.ps1` 在本机永远走不到（`freeze-restart-hidden.vbs` 存在即走 custom-chain），只在单测里验过分支选择，没有真机跑过它的 restart。
- **§6.3** 市场截图是否真被渲染，要发一个 patch 版本上去才能观察。
- **§3.9** CORS 仍是 `access-control-allow-origin: *`，同源判定没有收紧（等确认是否还用 `dsh-web-lan-access` 从别的设备访问）。

## 1.2.2 及更早

见 `git log`。
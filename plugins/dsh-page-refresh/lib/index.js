// dsh-page-refresh host 半边
//
// 2026-10-23 新增「重启 / 关闭」两条本地路由，供会话头的电源按钮调用。
// 注意：这里的「关闭」是关掉 DSH 本身，不是关电脑。
//
// 设计要点：
//   1. 重启复用 ~/.dsh/freeze-restart-hidden.vbs —— 那条 vbs 内部是
//      WScript.Shell.Run("cmd /c freeze-restart.cmd <fast>", 0, False)，
//      window style 0 = 完全不显示窗口，所以 cmd 一定不闪。带 fast 跳过链里
//      那 45 秒「等本轮回复落地」的延迟（按钮是主人主动点的，没有回合在飞）。
//      链路本身还会：停看门狗 → 杀 DSH → swap asar → 重拉 →
//      验端口 → 清 dsh-auth cookie → 恢复看门狗。
//   2. 关闭 DSH 不能简单 taskkill：看门狗（DSH Desktop Keepalive，每分钟一跑）
//      会在 3 次连续 miss 之后把 app 拉回来。正确做法是先往它自己的
//      update-journal 里追加一条 {"event":"quit-requested"}——autostart-desktop.vbs
//      的 QuitWasDeliberate() 判到这条就不再拉起（这是它 2026-10-05 就为
//      「托盘→退出」设计好的机制）。写完 journal 再延迟 800ms 杀，好让这条
//      HTTP 响应先发回去。
//   3. 都用 spawn(..., { detached: true, stdio: 'ignore', windowsHide: true })
//      + unref()：宿主进程随后被杀也不影响子进程；windowsHide 再保一道。
//   4. 只放行回环直连（remote 地址 + Host 头双判）—— 这是能关掉 app 的接口，
//      不能从局域网或隧道调到。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-page-refresh'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// 定制重启链只在本机存在；有就用它（清 cookie / swap asar / 验端口那套），
// 没有就走通用路径（见 dsh-power.ps1），这样插件搬到别人机器上也能用。
const RESTART_VBS = join(DSH_HOME, 'freeze-restart-hidden.vbs')
// journal 目录优先读环境变量（DSH 桌面版自己就靠它定位），否则用默认位置。
const JOURNAL_DIR = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR || join(DSH_HOME, 'logs', 'update-journal')
// 通用路径用的助手脚本，跟着插件走。
const POWER_PS1 = fileURLToPath(new URL('./dsh-power.ps1', import.meta.url))
// WMI 启动器。为什么需要它：本机 Electron host 跑在 Windows job object 里，
// spawn({detached:true}) 只新建进程组、进程仍在 job 内，父进程一退就被清掉
// （实测矩阵：detached true 三次全挂、false 三次全成）。WMI 由服务进程创建
// 子进程，不在我们的 job 里，能活过宿主。详见 wmi-launch.ps1 头部注释。
const WMI_LAUNCH = fileURLToPath(new URL('./wmi-launch.ps1', import.meta.url))

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
}

function sendJson(res, code, payload) {
  res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 只有本机桌面窗口 / 本机浏览器能过。
// remoteAddress 必须回环（防 DNS rebinding 的关键，不动）；
// Host 头放宽到「本机所有合法名称」—— 见 localHostNames()。
function isLoopback(req) {
  const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '')) return false
  const host = String(req.headers?.host ?? '').trim().toLowerCase()
  if (!host) return false
  // 去掉端口，再去掉 IPv6 的方括号
  const bare = host.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
  return localHostNames().has(bare)
}

// ---- 失败可诊断（issue #1 第 2 点）---------------------------------------
// 原来四种失败（404 / 500 / spawn ENOENT / 脚本提前 exit）长得一模一样，
// 用户只能看到 90 秒后那句「没重启起来」。这里把每一步都落到磁盘。
const LOG_DIR = join(DSH_HOME, 'logs')
const LOG_FILE = join(LOG_DIR, 'page-refresh-restart.log')

function logLine(tag, msg) {
  const line = `[${new Date().toISOString()}] ${tag} ${msg}\n`
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line, 'utf8')
  } catch { /* 日志失败不能拖垮主流程 */ }
  try { console.log('[page-refresh] ' + tag + ' ' + msg) } catch { /* GUI 无控制台 */ }
  return line
}

// ---- 环境清理（issue #1 第 1 点，主因）-----------------------------------
// host 半边是桌面壳用 ELECTRON_RUN_AS_NODE=1 拉起来的。spawn 会继承这个环境，
// Start-Process 再继承一次 —— 于是新起的「应用」以 Node 模式运行，没有窗口。
// 表现就是「重启了但什么都没发生」。@luoshuizhiwei/dsh-desktop-restart 也专门清它。
function cleanEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    const upper = k.toUpperCase()
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[k]
  }
  return env
}

function launchHidden(exe, args) {
  logLine('spawn-wmi', `${exe} ${args.join(' ')}`)
  if (!existsSync(WMI_LAUNCH)) {
    logLine('spawn-error', `wmi-launch.ps1 missing: ${WMI_LAUNCH}`)
    return null
  }
  // 故意不 detached：本机 detached 的子进程会被 job object 随父进程清掉
  // （实测三次全挂）。这个 launcher 只需活到 WMI 调用返回（约 1 秒），
  // 之后目标进程已由 WMI 服务创建、与我们无关。
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', WMI_LAUNCH,
    '-Exe', exe,
    '-Args', args.join(' '),
  ], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: cleanEnv(),
  })
  child.on('error', (e) => logLine('spawn-error', String(e?.message ?? e)))
  child.on('exit', (code) => logLine('spawn-exit', `code=${code}`))
  child.unref()
  return child
}

// ---- Host 白名单（放宽本机合法入口，仍以回环兜底）------------------------
// 原实现只认 127.0.0.1 / localhost / [::1]，用机器名或本机网卡 IP 打开就 403。
// remoteAddress 仍是回环这一条不改 —— 那是防 DNS rebinding 的关键。
function localHostNames() {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  try { names.add(hostname().toLowerCase()) } catch { /* ignore */ }
  try {
    const ifs = networkInterfaces()
    for (const key of Object.keys(ifs)) {
      names.add(key.toLowerCase())
      for (const a of ifs[key] ?? []) {
        if (a?.address) names.add(String(a.address).toLowerCase())
      }
    }
  } catch { /* ignore */ }
  return names
}

// 往最新一份 update-journal 追加 {"event":"quit-requested"}。
// autostart-desktop.vbs 的 QuitWasDeliberate() 在这份 journal 里找到该标记后，
// 就认定是主人主动退出、不再拉起 —— 这正是托盘「退出」走的同一条路。
// 返回被写入的 journal 路径；失败抛错（宁可报错，也别让看门狗把 app 拉回来）。
function appendQuitRequested() {
  if (!existsSync(JOURNAL_DIR)) throw new Error(`update journal dir not found: ${JOURNAL_DIR}`)
  let newest = ''
  let newestMs = 0
  for (const name of readdirSync(JOURNAL_DIR)) {
    if (!name.toLowerCase().endsWith('.jsonl')) continue
    const full = join(JOURNAL_DIR, name)
    const st = statSync(full)
    if (st.mtimeMs > newestMs) {
      newestMs = st.mtimeMs
      newest = full
    }
  }
  if (!newest) throw new Error('no update journal found')

  const raw = readFileSync(newest, 'utf8')
  if (raw.includes('"event":"quit-requested"')) return newest // 已经写过，幂等

  let seq = -1
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (typeof rec.sequence === 'number' && rec.sequence > seq) seq = rec.sequence
    } catch { /* 坏行跳过 */ }
  }
  const record = {
    schemaVersion: 1,
    sequence: seq + 1,
    time: new Date().toISOString(),
    event: 'quit-requested',
  }
  const lead = raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''
  appendFileSync(newest, lead + JSON.stringify(record) + '\n', 'utf8')
  return newest
}

export function apply(ctx) {
  const route = (path, handle) => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      if (!isLoopback(req)) {
        const host = String(req.headers?.host ?? '-')
        const remote = String(req.socket?.remoteAddress ?? '-')
        logLine('denied', `${path} host=${host} remote=${remote}`)
        res.writeHead(403, { ...CORS, 'content-type': 'text/plain; charset=utf-8' })
        res.end(
          'power API is loopback-only\n' +
          `收到的 Host 头: ${host}\n` +
          `收到的来源地址: ${remote}\n` +
          '若你是在本机用「机器名」或「网卡 IP」打开 DSH 的，请把该名称告诉我；\n' +
          '若这是从别的设备访问的，这条接口按设计不接受远程调用。\n'
        )
        return
      }
      try {
        sendJson(res, 200, await handle())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // 只读自检：验证路由已注册、fence 已通过，且不产生任何副作用。
  // 2026-10-29 扩充诊断字段（issue #1）：把「为什么重启不了」的判据直接暴露出来。
  route('/api/power/status', () => ({
    ok: true,
    restartMode: existsSync(RESTART_VBS) ? 'custom-chain' : 'portable',
    restartChain: existsSync(RESTART_VBS) ? RESTART_VBS : POWER_PS1,
    portableScript: POWER_PS1,
    portableScriptExists: existsSync(POWER_PS1),
    journalDir: JOURNAL_DIR,
    journalReady: existsSync(JOURNAL_DIR),
    endpoints: ['/api/power/restart', '/api/power/close'],
    // --- 诊断 ---
    execPath: process.execPath,
    nodeVersion: process.version,
    // 这个值非空就是 issue #1 的主因：新起的应用会变成没有窗口的 Node 进程。
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    dshDesktopNodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? null,
    // 允许的 Host 名单（放宽后）
    hostNames: [...localHostNames()],
    logFile: LOG_FILE,
    logExists: existsSync(LOG_FILE),
    isWindows: process.platform === 'win32',
  }))

  route('/api/power/restart', () => {
    // 本机有定制链就用它：清 dsh-auth cookie、swap asar、验端口、恢复看门狗，
    // 这些别人机器上没有也不需要。fast = 跳过链里那 45 秒「等本轮回复落地」的
    // 延迟（按钮是主人主动点的，没有 agent 回合在飞）。
    if (existsSync(RESTART_VBS)) {
      logLine('restart', 'mode=custom-chain')
      launchHidden('wscript.exe', [RESTART_VBS, 'fast'])
      return { ok: true, kind: 'restart', mode: 'custom-chain', delayMs: 0, logFile: LOG_FILE, message: '正在重启 DeepSeek Harness' }
    }
    // 通用路径：读完原命令行再杀、用同样参数重拉（dsh-power.ps1 自己做这件事）。
    if (!existsSync(POWER_PS1)) {
      const msg = `portable power script not found: ${POWER_PS1}`
      logLine('restart-error', msg)
      throw new Error(msg)
    }
    logLine('restart', `mode=portable script=${POWER_PS1} electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'}`)
    launchHidden('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', POWER_PS1, '-Action', 'restart',
    ])
    return { ok: true, kind: 'restart', mode: 'portable', delayMs: 0, logFile: LOG_FILE, message: '正在重启 DeepSeek Harness' }
  })

  route('/api/power/close', () => {
    // 尽力写一条 quit-requested：装了看门狗的机器，读到它就不会把 app 再拉起来。
    //
    // 但这一步必须「尽力而为」，不能拦着关闭 —— 查过 app.asar，journal 是 opt-in 的：
    //   const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
    //   const updateJournal = journalDirectory === void 0 ? void 0 : new DesktopUpdateJournal(...)
    // 没设这个环境变量时 app 自己根本不建 journal，托盘退出也不会写它。而设置它的
    // launch-desktop.cmd 和读取它的 autostart-desktop.vbs 都是本机定制件，别人机器上
    // 一样没有 —— 那种机器上没人会来拉回 app，直接杀即可。
    let journal = ''
    try {
      journal = appendQuitRequested()
      logLine('close', `mode=taskkill journal=${journal}`)
    } catch (e) {
      journal = ''
      logLine('close', `mode=taskkill journal-skip reason=${String(e?.message ?? e)}`)
    }
    // 关闭不需要 dsh-power.ps1：那条通用脚本是为「重启要保留原命令行」准备的，
    // 而关闭只是杀进程。powershell.exe 冷启动要 1~2 秒，taskkill 是原生程序，
    // 一百多毫秒就杀完 —— 这一换就是主人感觉到的「太慢」。
    //
    // 不再加 setTimeout 保险：taskkill 自己要 160ms 左右才动手，而 sendJson 是
    // 毫秒级的同步写 socket，响应先出去没问题。原来那 120ms 是白等的。
    launchHidden('taskkill.exe', ['/IM', 'DeepSeek Harness.exe', '/F'])
    return {
      ok: true,
      kind: 'close',
      delayMs: 0,
      journal,
      message: '正在关闭 DeepSeek Harness',
    }
  })
}

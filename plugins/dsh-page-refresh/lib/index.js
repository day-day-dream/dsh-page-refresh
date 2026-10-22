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
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
function isLoopback(req) {
  const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '')) return false
  const host = String(req.headers?.host ?? '').trim().toLowerCase()
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

function launchHidden(exe, args) {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
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
        console.log(`[page-refresh] power denied ${path} host=${req.headers?.host ?? '-'} remote=${req.socket?.remoteAddress ?? '-'}`)
        res.writeHead(403, { ...CORS, 'content-type': 'text/plain; charset=utf-8' })
        res.end('power API is loopback-only\n')
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
  route('/api/power/status', () => ({
    ok: true,
    restartMode: existsSync(RESTART_VBS) ? 'custom-chain' : 'portable',
    restartChain: existsSync(RESTART_VBS) ? RESTART_VBS : POWER_PS1,
    portableScript: POWER_PS1,
    journalDir: JOURNAL_DIR,
    journalReady: existsSync(JOURNAL_DIR),
    endpoints: ['/api/power/restart', '/api/power/close'],
  }))

  route('/api/power/restart', () => {
    // 本机有定制链就用它：清 dsh-auth cookie、swap asar、验端口、恢复看门狗，
    // 这些别人机器上没有也不需要。fast = 跳过链里那 45 秒「等本轮回复落地」的
    // 延迟（按钮是主人主动点的，没有 agent 回合在飞）。
    if (existsSync(RESTART_VBS)) {
      launchHidden('wscript.exe', [RESTART_VBS, 'fast'])
      return { ok: true, kind: 'restart', mode: 'custom-chain', delayMs: 0, message: '正在重启 DeepSeek Harness' }
    }
    // 通用路径：读完原命令行再杀、用同样参数重拉（dsh-power.ps1 自己做这件事）。
    if (!existsSync(POWER_PS1)) {
      throw new Error(`portable power script not found: ${POWER_PS1}`)
    }
    launchHidden('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', POWER_PS1, '-Action', 'restart',
    ])
    return { ok: true, kind: 'restart', mode: 'portable', delayMs: 0, message: '正在重启 DeepSeek Harness' }
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
    } catch {
      journal = ''
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

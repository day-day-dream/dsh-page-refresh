// §3.4 + §7-2 单测：close 的杀树分支、父进程名核验、以及 restart 的 portable 兜底分支。
//
// 安全设计（本文件存在的全部理由）：
//   · spawn / execFile 都被假模块整体替换 ⇒ 本测试不产生任何真实进程，不会杀掉任何 DSH，
//     也不会真的调 tasklist 去读宿主 ppid。
//   · journal 与 log 全部改道到 lab 临时目录 ⇒ 不会往真 update-journal 写 quit-requested
//     （那条一写，autostart-desktop.vbs 就会认定「用户故意退出」，看门狗从此不再拉起 app）。
//
// 断言注意：taskkill 的 argv 是**拼成一个字符串**塞进 wmi-launch.ps1 的 -Args 位置的
// （argv 里没有独立的 '/T' 元素），所以判据是「-Args 的下一个元素精确等于某串」。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const SRC = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const DIR = join(tmpdir(), 'dsh-page-refresh-tests')
const REAL_JOURNAL = join(process.env.USERPROFILE || homedir(), '.dsh', 'logs', 'update-journal')
mkdirSync(DIR, { recursive: true })
mkdirSync(join(DIR, 'logs'), { recursive: true })
mkdirSync(join(DIR, 'journal'), { recursive: true })
writeFileSync(join(DIR, 'wmi-launch.ps1'), '# stub: 只为让 existsSync(WMI_LAUNCH) 通过\n')
writeFileSync(join(DIR, 'dsh-power.ps1'), '# stub: 只为让 portable 分支的 existsSync(POWER_PS1) 通过\n')
writeFileSync(join(DIR, 'journal', 'probe.jsonl'), '')
// 故意不建 freeze-restart-hidden.vbs ⇒ restart 必须走 portable 兜底分支

const snapshot = (d) => {
  if (!existsSync(d)) return '(目录不存在)'
  return readdirSync(d).sort().map((f) => {
    try { const s = statSync(join(d, f)); return f + ':' + s.size + ':' + s.mtimeMs } catch { return f + ':?' }
  }).join('|')
}
const realBefore = snapshot(REAL_JOURNAL)

const FAKE = join(DIR, 'fake-cp.mjs')
writeFileSync(FAKE, `export const calls = []
export const execCalls = []
let execOut = { err: null, stdout: '' }
export function setExecResult(err, stdout) { execOut = { err, stdout } }
export function spawn(exe, args, opts) {
  calls.push({ exe, args, opts })
  return { stdout: { on() {} }, stderr: { on() {} }, on() {}, unref() {} }
}
export function execFile(exe, args, opts, cb) {
  execCalls.push({ exe, args })
  cb(execOut.err, execOut.stdout)
}
`)

let code = readFileSync(SRC, 'utf8')
const patched = code.replace("from 'node:child_process'", "from './fake-cp.mjs'")
if (patched === code) {
  console.log('FAIL 未能改写 child_process import，测试中止')
  process.exit(1)
}
writeFileSync(join(DIR, 'index.mjs'), patched)

process.env.DSH_HOME = DIR
process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR = join(DIR, 'journal')

const fake = await import(pathToFileURL(FAKE).href)
const mod = await import(pathToFileURL(join(DIR, 'index.mjs')).href + '?v=' + Date.now())

const routes = {}
mod.apply({ webServer: { register: (r) => { routes[r.path] = r; return () => {} } } })

let ppidFaked = false
try {
  Object.defineProperty(process, 'ppid', { value: 4242, configurable: true })
  ppidFaked = process.ppid === 4242
} catch {}
const expectPid = String(process.ppid)

const fakeReq = (method) => ({ method, headers: { host: '127.0.0.1:57798' }, socket: { remoteAddress: '127.0.0.1' } })
const fakeRes = () => {
  const cap = {}
  return { cap, writeHead(c) { cap.status = c }, end(b) { if (b) cap.body = String(b) } }
}

async function hit(path) {
  fake.calls.length = 0
  fake.execCalls.length = 0
  const res = fakeRes()
  await routes[path].handler(fakeReq('POST'), res)
  const c = fake.calls[0]
  const a = (c && c.args) || []
  const ai = a.indexOf('-Args')
  return {
    status: res.cap.status,
    call: c,
    argv: a,
    argsVal: ai >= 0 ? a[ai + 1] : '',
    exe: (a[a.indexOf('-Exe') + 1]) || '',
    execCount: fake.execCalls.length,
  }
}

let bad = 0
const line = (ok, msg) => { if (!ok) bad++; console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg) }

console.log('  process.ppid 伪造: ' + (ppidFaked ? 'YES（期望值 ' + expectPid + '）' : 'NO（用真实 ' + process.ppid + '）'))
console.log('')

// ── A：desktop-host 且 tasklist 核出父进程确实是 app → 按 PID 杀树 ──
process.env.ELECTRON_RUN_AS_NODE = '1'
fake.setExecResult(null, '"DeepSeek Harness.exe","4242","Console","1","100,000 K"\r\n')
let r = await hit('/api/power/close')
line(r.status === 200, 'A HTTP ' + r.status + '（期望 200）')
line(r.exe === 'taskkill.exe', 'A 目标是 taskkill.exe')
line(r.argsVal === '/PID ' + expectPid + ' /T /F', "A -Args 精确等于 '/PID " + expectPid + " /T /F'  实际='" + r.argsVal + "'")
line(!r.argsVal.includes('/IM'), 'A 不带 /IM（不按镜像名杀）')
line(r.execCount === 1, 'A 核验跑了一次 tasklist（1 次）')
console.log('')

// ── A2：ppid 名不是 app（手工设环境变量跑 CLI 的场景）→ 退回按名杀 ──
fake.setExecResult(null, '"cmd.exe","4242","Console","1","5,000 K"\r\n')
r = await hit('/api/power/close')
line(r.argsVal === '/IM "DeepSeek Harness.exe" /F', "A2 -Args 退回 '/IM \"DeepSeek Harness.exe\" /F'  实际='" + r.argsVal + "'")
line(!r.argsVal.includes('/PID'), 'A2 不按 ppid 杀（终端不会被带走）')
console.log('')

// ── A3：tasklist 失败/读不到 → 仍按树杀（真机验收后修正：读不到 ≠ R1 场景）──
fake.setExecResult(new Error('tasklist blocked'), '')
r = await hit('/api/power/close')
line(r.argsVal === '/PID ' + expectPid + ' /T /F', "A3 读不到父进程名时仍按树杀  实际='" + r.argsVal + "'")
console.log('')

// ── A4：tasklist 有输出但一行都匹配不到 ──
fake.setExecResult(null, '信息: 没有运行的任务匹配指定标准。\r\n')
r = await hit('/api/power/close')
line(r.argsVal === '/PID ' + expectPid + ' /T /F', "A4 无匹配行时仍按树杀  实际='" + r.argsVal + "'")
console.log('')

// ── B：CLI 场景（无 ELECTRON_RUN_AS_NODE）→ 直接按名杀，且不做核验 ──
delete process.env.ELECTRON_RUN_AS_NODE
fake.setExecResult(null, '"explorer.exe","4242","Console","1","1 K"\r\n')
r = await hit('/api/power/close')
line(r.argsVal === '/IM "DeepSeek Harness.exe" /F', "B -Args 精确等于 '/IM \"DeepSeek Harness.exe\" /F'  实际='" + r.argsVal + "'")
line(r.execCount === 0, 'B 不做核验（0 次 tasklist，省掉那 270ms）')
console.log('')

// ── D：restart 的 portable 兜底分支（本机没有 freeze-restart-hidden.vbs 时）──
r = await hit('/api/power/restart')
line(r.status === 200, 'D HTTP ' + r.status + '（期望 200）')
line(r.exe === 'powershell.exe', 'D 目标换成 powershell.exe（dsh-power.ps1 是 PS 脚本）')
line(r.argsVal.includes('dsh-power.ps1') && r.argsVal.includes('-Action restart'), "D -Args 指向 dsh-power.ps1 -Action restart  实际='" + r.argsVal + "'")
console.log('')

// ── C：留痕 + 不污染真 journal ──
let logText = ''
for (const f of readdirSync(join(DIR, 'logs'), { withFileTypes: true })) {
  if (f.isFile()) logText += readFileSync(join(DIR, 'logs', f.name), 'utf8')
}
line(logText.includes('kill-mode=tree pid=' + expectPid + ' parent=DeepSeek Harness.exe'), 'C 日志含 kill-mode=tree + parent=…')
line(logText.includes('kill-mode=image reason=parent-not-app'), 'C 日志含 kill-mode=image reason=parent-not-app')
line(logText.includes('kill-mode=image reason=not-desktop-host'), 'C 日志含 kill-mode=image reason=not-desktop-host')
line(logText.includes('mode=portable'), 'C 日志含 restart mode=portable')
const labJournal = readFileSync(join(DIR, 'journal', 'probe.jsonl'), 'utf8')
line(labJournal.includes('quit-requested'), 'C quit-requested 写进了 lab journal')
line(realBefore === snapshot(REAL_JOURNAL), 'C 真 update-journal 未被触碰（前后快照一致）')
// ── E：日志轮转（§3.7）—— 提案的验收判据是「造一个 >5MB 的文件，跑一次 close，确认生成 .1」
const logDir = join(DIR, 'logs')
const logNames = readdirSync(logDir).filter((f) => f.endsWith('.log') && !f.endsWith('.log.1'))
line(logNames.length === 1, 'E 基准日志文件 ' + JSON.stringify(logNames))
const logFile = join(logDir, logNames[0])
const bigSize = 5 * 1024 * 1024 + 4096
writeFileSync(logFile, 'x'.repeat(bigSize))
process.env.ELECTRON_RUN_AS_NODE = '1'
fake.setExecResult(null, '"DeepSeek Harness.exe","4242","Console","1","1 K"\r\n')
await hit('/api/power/close')
const rotatedOk = existsSync(logFile + '.1')
line(rotatedOk, 'E 超过 5MB 后轮转出 .log.1（原文件 ' + bigSize + ' 字节）')
line(rotatedOk && statSync(logFile + '.1').size >= bigSize, 'E .log.1 保留了旧内容')
line(statSync(logFile).size < 64 * 1024, 'E 新日志从头开始（' + statSync(logFile).size + ' 字节）')
console.log('')

console.log('  失败数: ' + bad)
process.exit(bad === 0 ? 0 : 1)
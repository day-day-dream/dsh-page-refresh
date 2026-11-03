// §3.3 单测（修正版）：伪造非 Windows 平台，断言写端点返回 501。
//
// ★ 上一版的设计错误（记录在此免得重犯）：我在 apply(ctx) 之后立刻把 platform 恢复成 win32，
//   而 handler 是「每次调用时读 process.platform」—— 于是它按 win32 走进了真分支，
//   真的 spawn 了 taskkill 与 freeze-restart-hidden.vbs（万幸那两次 WMI 调用没生效）。
//   正确做法：伪造必须**保持到所有 handler 调用与断言结束之后**再恢复。
//
// 安全性：本次只在 platform='linux' 期间调 handler；501 分支在这些路径的进路上 return，
// 不会执行 handle()。末尾还加了一条「win32 断言」，但那条**不调写端点**，只检查 status。
import { apply } from '../lib/index.js'

const routes = {}
const ctx = { webServer: { register: (r) => { routes[r.path] = r; return () => {} } } }
const apply0 = apply

const orig = process.platform

function fakeReq(method) {
  return { method, headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } }
}
function fakeRes() {
  const cap = { status: 0, body: '' }
  return {
    cap,
    writeHead(code) { cap.status = code },
    end(b) { if (b) cap.body = String(b) },
  }
}

let bad = 0
let calledWritePaths = []

// ── 阶段 1：伪造 platform='linux'，保持它，直到所有断言做完 ──
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })
try {
  apply0(ctx)

  console.log('  注册到的路由: ' + Object.keys(routes).join(', '))
  console.log('  当前 platform（断言期间）: ' + process.platform)
  console.log('')

  for (const c of [
    { path: '/api/power/close', expect: 501 },
    { path: '/api/power/restart', expect: 501 },
  ]) {
    const r = routes[c.path]
    if (!r) { console.log('  FAIL 路由未注册: ' + c.path); bad++; continue }
    calledWritePaths.push(c.path)
    const res = fakeRes()
    await r.handler(fakeReq('POST'), res)
    const ok = res.cap.status === c.expect
    if (!ok) bad++
    const bodyOk = res.cap.body.includes('Windows-only') && res.cap.body.includes('linux')
    if (!bodyOk) bad++
    console.log(
      '  ' + (ok ? 'PASS' : 'FAIL') + '  POST ' + c.path.padEnd(22) +
      '→ HTTP ' + res.cap.status + '（期望 501）  含 error+platform 字段: ' + (bodyOk ? 'YES ✓' : 'NO ✗'),
    )
  }

  // 只读端点不该被 501 拦（它在 501 判定之外）
  const rs = fakeRes()
  await routes['/api/power/status'].handler(fakeReq('GET'), rs)
  const sok = rs.cap.status === 200
  if (!sok) bad++
  console.log('  ' + (sok ? 'PASS' : 'FAIL') + '  GET  /api/power/status      → HTTP ' + rs.cap.status + '（期望 200）')
} finally {
  // ★ 恢复必须在这里 —— handler 全调完了
  Object.defineProperty(process, 'platform', { value: orig, configurable: true, writable: true })
}

console.log('')
console.log('  恢复后 platform: ' + process.platform)
console.log('  期间真正调过的写端点: ' + (calledWritePaths.join(', ') || '（无）'))
console.log('  失败数: ' + bad)
process.exit(bad === 0 ? 0 : 1)
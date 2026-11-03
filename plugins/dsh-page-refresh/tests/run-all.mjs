// 跑齐 tests/ 下的全部验收脚本，汇总失败数。
//
// 这三个脚本都不产生真实进程（spawn / execFile 被假模块替换），
// 也不碰真实 journal（改道到系统临时目录），所以在任何机器上都能安全跑。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const scripts = ['verify-treekill.mjs', 'verify-501.mjs', 'verify-quotearg.cjs']

let bad = 0
for (const s of scripts) {
  console.log('')
  console.log('================ ' + s + ' ================')
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: 'inherit' })
  if (r.status !== 0) {
    bad++
    console.log('  -> 该脚本失败，exit=' + (r.status === null ? '(被信号中断)' : r.status))
  }
}
console.log('')
console.log('================ 汇总 ================')
console.log('  脚本数 ' + scripts.length + '，失败 ' + bad)
process.exit(bad === 0 ? 0 : 1)
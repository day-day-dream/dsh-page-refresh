// §3.5 行为验证：quoteArg 的 A/B 用例 + 全参数拼接（断言不出现双层引号）。
//
// 注意：本测试**从 lib/index.js 里读源码抽出真实实现**，而不是把实现抄一份。
// 抄一份的问题是：将来改了实现，测试照样绿 —— 那种测试等于没有。
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')
const m = src.match(/const quoteArg = [^\n]+/)
if (!m) {
  console.log('FAIL 没能在 lib/index.js 里找到 quoteArg 定义，测试无法进行')
  process.exit(1)
}
// eslint-disable-next-line no-eval
const quoteArg = eval('(' + m[0].replace(/^const quoteArg = /, '') + ')')
console.log('  抽出实现: ' + m[0])

const cases = [
  ['DeepSeek Harness.exe', '"DeepSeek Harness.exe"'],
  ['taskkill.exe', 'taskkill.exe'],
  ['C:/dir with space/marker.ps1', '"C:/dir with space/marker.ps1"'],
  ['C:/plain/marker.ps1', 'C:/plain/marker.ps1'],
  ['fast', 'fast'],
]
let bad = 0
for (const [input, expected] of cases) {
  const got = quoteArg(input)
  const ok = got === expected
  if (!ok) bad++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  quoteArg(${JSON.stringify(input)}) = ${JSON.stringify(got)}${ok ? '' : '  expected ' + JSON.stringify(expected)}`)
}

const full = (args) => args.map(quoteArg).join(' ')
const joined = full(['/IM', 'DeepSeek Harness.exe', '/F'])
console.log('')
console.log('  拼出的 -Args: ' + joined)
const noDouble = !joined.includes('""')
if (!noDouble) bad++
console.log(`  ${noDouble ? 'PASS' : 'FAIL'}  含双层引号? ${noDouble ? 'NO（正确）' : 'YES（错误）'}`)

const marker = full(['-File', 'C:/feasibility/dir with space/marker.ps1'])
console.log('  含空格路径拼接: ' + marker)
const pathQuoted = marker.includes('"C:/feasibility/dir with space/marker.ps1"')
if (!pathQuoted) bad++
console.log(`  ${pathQuoted ? 'PASS' : 'FAIL'}  该路径被引号包住? ${pathQuoted ? 'YES（正确）' : 'NO（错误）'}`)

console.log('')
console.log('  失败数: ' + bad)
process.exit(bad === 0 ? 0 : 1)
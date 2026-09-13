/** 极简测试框架：分组、断言、彩色输出、汇总统计 */

export const results = [];
let currentGroup = '';

export function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

export async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: true, ms });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${ms}ms)\x1b[0m`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: false, ms, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[90m(${ms}ms)\x1b[0m`);
    console.log(`    \x1b[31m${err?.message || err}\x1b[0m`);
  }
}

/** 只打印一行说明，用于展示中间结果 */
export function info(text) {
  console.log(`      \x1b[90m${String(text).replace(/\n/g, '\n      ')}\x1b[0m`);
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || '断言失败'}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`
    );
  }
}

export function assertMatch(value, regex, message) {
  if (!regex.test(String(value))) {
    throw new Error(`${message || '断言失败'}\n      实际: ${JSON.stringify(value)}`);
  }
}

export function summary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(60));
  console.log(
    `\x1b[1m合计 ${results.length} 项：\x1b[32m通过 ${passed}\x1b[0m  \x1b[31m失败 ${failed.length}\x1b[0m`
  );
  if (failed.length) {
    console.log('\n失败明细：');
    failed.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m [${f.group}] ${f.name}\n     ${f.error?.message}`));
  }
  return failed.length;
}

'use strict';
// symbol.js —— 代码格式转换，严格复刻 src-tauri/src/api/symbol.rs。
// 唯一接受的输入：纯 6 位数字字符串。不做任何清洗/补零/去前缀处理。

function validCode(code) {
  return typeof code === 'string' && code.length === 6 && /^[0-9]{6}$/.test(code);
}

// Listed mainland company stocks. Funds/bonds/indices must not use corporate financials.
function companyStock(code) {
  return validCode(code) && ['60', '68', '00', '30', '92'].some((p) => code.startsWith(p));
}

function isLegacyBeijing(code) {
  return validCode(code) && ['43', '83', '87'].some((p) => code.startsWith(p));
}

// 返回 'Shanghai' | 'Shenzhen' | 'Beijing' | null
function exchange(code) {
  if (!validCode(code)) return null;
  if (code.startsWith('92') || code[0] === '4' || code[0] === '8') return 'Beijing';
  if (code[0] === '5' || code[0] === '6' || code[0] === '9') return 'Shanghai';
  return 'Shenzhen';
}

function tencentSymbol(code) {
  const ex = exchange(code);
  if (ex === null) return null;
  const prefix = ex === 'Shanghai' ? 'sh' : ex === 'Shenzhen' ? 'sz' : 'bj';
  return prefix + code;
}

function eastmoneyMarket(code) {
  const ex = exchange(code);
  if (ex === null) return null;
  return ex === 'Shanghai' ? 1 : 0;
}

function eastmoneySecid(code) {
  const market = eastmoneyMarket(code);
  if (market === null) return null;
  return `${market}.${code}`;
}

module.exports = {
  validCode,
  companyStock,
  isLegacyBeijing,
  exchange,
  tencentSymbol,
  eastmoneyMarket,
  eastmoneySecid,
};

'use strict';
// 交易日历：硬编码 2025/2026 上交所休市区间（来源见 API-SPEC 第五章 §4）。
// 未知年份一律返回 null（未确认），调用方以 === true 为放行条件。
const CLOSURES = {
  2025: [[101, 101], [128, 204], [404, 406], [501, 505], [531, 602], [1001, 1008]],
  2026: [[101, 103], [215, 223], [404, 406], [501, 505], [619, 621], [925, 927], [1001, 1007]],
};
const SOURCES = [
  'https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml',
  'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
];
const YEARS = [2025, 2026];

function pad(n) { return String(n).padStart(2, '0'); }
// Intl.DateTimeFormat 构造较贵且无状态可复用：alerts/reports/warm 的周期 tick 都会调
// shanghaiNow()，提为模块级实例避免每次重建。
const SHANGHAI_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
// 上海日期工具：统一以 'YYYY-MM-DD' 字符串为日期表示，避免时区漂移
function shanghaiNow() {
  const parts = {};
  for (const p of SHANGHAI_FMT.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
function todayStr() { return shanghaiNow().date; }
function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function weekdayMon1(dateStr) { // 1=周一 .. 7=周日
  const d = new Date(`${dateStr}T12:00:00Z`);
  const w = d.getUTCDay(); // 0=周日
  return w === 0 ? 7 : w;
}
function isTradingDay(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const table = CLOSURES[year];
  if (!table) return null;
  if (weekdayMon1(dateStr) > 5) return false;
  const mmdd = Number(dateStr.slice(5, 7)) * 100 + Number(dateStr.slice(8, 10));
  for (const [a, b] of table) if (mmdd >= a && mmdd <= b) return false;
  return true;
}
function previousTradingDay(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 20; i++) {
    d = addDays(d, -1);
    const t = isTradingDay(d);
    if (t === null) return null;
    if (t === true) return d;
  }
  return null;
}
module.exports = { CLOSURES, SOURCES, YEARS, shanghaiNow, todayStr, addDays, weekdayMon1, isTradingDay, previousTradingDay, pad };

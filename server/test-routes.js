'use strict';
// test-routes.js —— 数据路由自测：用真实 gateway 依次调用主要路由，
// 把返回 data 的顶层键集合与夹具 ~/workspace/stock-web/test/routes.json 同名条目对比。
//
// 判定规则：夹具为精简样本（键集合是完整实现的真子集），因此
//   PASS = 请求成功（success:true）且夹具 data 的全部顶层键都出现在实际 data 中；
//   实际多出的键列为 extra 仅提示不判失败；夹具缺失的键列为 missing 判 FAIL。
// 上游网络失败如实标 FAIL 并附错误码，不伪造通过。
// 用法：node test-routes.js

const fs = require('node:fs');
const path = require('node:path');
const { createGateway } = require('./gateway');
const { createDataRoutes } = require('./routes-data');

const FIXTURE_PATH = path.join(__dirname, '..', 'test', 'routes.json');

function topKeys(data) {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return ['<array>'];
  if (typeof data === 'object') return Object.keys(data).sort();
  return [`<${typeof data}>`];
}

// 特殊对照口径（夹具与本次测试参数/实现形状不一致处，以 Rust 源码为准）：
// - 'stock' / 'market-warnings'：夹具 data 以捕获时的股票代码为键（600000 / 600664），
//   本次测试请求的是 600519,000858，故改为校验「实际键包含本次请求的代码」。
// - 'limit-up' 夹具是占位 stub（{items:[], summary:{}}），summary 形状以 endpoints.rs 为准。
// - 'stock-minute' 夹具是占位 stub（{points:[], latest:null}，Rust 无 latest 字段），形状以 minute.rs 为准。
const EXPECTED_KEYS_OVERRIDE = {
  'limit-up:summary': [
    'breakRate', 'date', 'dtCount', 'ladder', 'maxHeight', 'promoteRate', 'yztCount', 'zbCount', 'ztCount',
  ],
  'stock-minute': [
    'code', 'command', 'count', 'fallbackReason', 'latestTime', 'market', 'name', 'points',
    'preClose', 'source', 'sourceLabel', 'tradeDate',
  ],
};

async function main() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const gw = createGateway();
  const routes = createDataRoutes(gw);

  // [夹具键名, 路径, query]
  const cases = [
    ['stock', '/stock', { codes: '600519,000858' }],
    ['market-data', '/market-data', { type: 'index' }],
    ['market-data', '/market-data', { type: 'breadth' }],
    ['market-data', '/market-data', { type: 'sector-panorama' }],
    ['market-data', '/market-data', { type: 'capital' }],
    ['market-data', '/market-data', { type: 'sector' }],
    ['stock-search', '/stock-search', { q: '茅台' }],
    ['stock-kline', '/stock-kline', { code: '600519' }],
    ['stock-minute', '/stock-minute', { code: '600519' }],
    ['fund-flow-120d', '/fund-flow-120d', { codes: '600519' }],
    ['stock-news', '/stock-news', { code: '600519' }],
    ['limit-up', '/limit-up', { type: 'summary' }],
    ['hot-rank', '/hot-rank', { source: 'ths' }],
    ['hot-rank', '/hot-rank', { source: 'em' }],
    ['cls-news', '/cls-news', {}],
    ['global-news', '/global-news', {}],
    ['news', '/news', {}],
    ['sector-rotation', '/sector-rotation', {}],
    ['market-warnings', '/market-warnings', { codes: '600519' }],
    ['intraday-screening', '/intraday-screening', {}],
    ['stock-risk', '/stock-risk', { code: '600519' }],
    ['dragon-tiger', '/dragon-tiger', {}],
    ['stock-fundamentals', '/stock-fundamentals', { code: '600519' }],
    ['stock-research', '/stock-research', { code: '600519' }],
    ['opportunity-radar', '/opportunity-radar', {}],
  ];

  let pass = 0;
  let fail = 0;
  for (const [fixtureKey, routePath, query] of cases) {
    const label = `${routePath} ${JSON.stringify(query)}`;
    const started = Date.now();
    let envelope;
    try {
      envelope = await routes.handle(routePath, query);
    } catch (error) {
      fail += 1;
      console.log(`FAIL ${label} — handle 抛错: ${error.message} (code=${error.code || '?'})`);
      continue;
    }
    const elapsed = `${Date.now() - started}ms`;
    if (!envelope || envelope.success !== true) {
      fail += 1;
      const code = envelope ? envelope.errorCode || envelope.error || '?' : '?';
      const status = envelope && envelope.status != null ? ` status=${envelope.status}` : '';
      console.log(`FAIL ${label} — 请求失败 errorCode=${code}${status} (${elapsed})`);
      continue;
    }
    const fixture = fixtures[fixtureKey];
    let expected;
    if (fixtureKey === 'limit-up' && query.type === 'summary') {
      expected = EXPECTED_KEYS_OVERRIDE['limit-up:summary'];
    } else if (fixtureKey === 'stock-minute') {
      expected = EXPECTED_KEYS_OVERRIDE['stock-minute'];
    } else if ((fixtureKey === 'stock' || fixtureKey === 'market-warnings') && query.codes) {
      // data 以股票代码为键：校验本次请求的代码都在实际结果中
      expected = query.codes.split(',').map((c) => c.trim());
    } else if (!fixture) {
      console.log(`PASS ${label} — 成功（无同名夹具可比） (${elapsed})`);
      pass += 1;
      continue;
    } else {
      expected = topKeys(fixture.data);
    }
    const actual = topKeys(envelope.data);
    const missing = expected.filter((key) => !actual.includes(key));
    const extra = actual.filter((key) => !expected.includes(key));
    if (missing.length === 0) {
      pass += 1;
      console.log(
        `PASS ${label} — data 键 ${actual.length} 个，夹具 ${expected.length} 个全覆盖` +
          (extra.length > 0 ? `，extra=[${extra.join(',')}]` : '') +
          ` (${elapsed})`,
      );
    } else {
      fail += 1;
      console.log(
        `FAIL ${label} — missing=[${missing.join(',')}]` +
          (extra.length > 0 ? ` extra=[${extra.join(',')}]` : '') +
          ` (${elapsed})`,
      );
    }
  }
  console.log(`\n合计: PASS ${pass} / FAIL ${fail} / 总 ${pass + fail}`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('自测脚本异常:', error);
  process.exitCode = 2;
});

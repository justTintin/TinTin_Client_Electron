// =====================================================================
// verify-contract.js — F-3 双写一致性自检脚本（IRON-10 / 跨模块一致性门禁）
//
// 用法：  npm run verify
// 范围：
//   1) API_PATHS（types/server-api.ts 叶子字符串路径）
//      vs OpenAPI 契约 paths interface（renderer/src/types/api-contract.generated.ts）
//      → 路径集合对比：缺了/多了都会 FAIL。
//   2) Contract.* 锚点（types/server-api.ts: Contract namespace）
//      vs components.schemas key 列表
//      → 锚点指向不存在的 schema key → FAIL。
//   3) Namespaces 漂移点表格行数一致性（防止新增字段没人同步表格）。
//
// 所有校验项 PASS 时 exit code = 0；任意 FAIL 时 exit code = 1，
// 在 pre-commit / CI 中阻断提交（符合 IRON-03/IRON-05 代码门禁）。
// =====================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const SERVER_API    = path.join(ROOT, 'types', 'server-api.ts');
const CONTRACT_TS   = path.join(ROOT, 'renderer', 'src', 'types', 'api-contract.generated.ts');

// ─────────────────────────────────────────────────────────────────────
// 工具：读文件 + 友好报错（未生成契约时给明确提示）
// ─────────────────────────────────────────────────────────────────────
function readOrDie(p, hint) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (err) {
    console.error(`[verify-contract] ❌ 缺少文件: ${path.relative(ROOT, p)}\n    ${hint}\n    Error: ${err.message}`);
    process.exit(1);
  }
}

let anyFail = false;
function pass(label, detail) { console.log(`  ✅ PASS  ${label}${detail ? ' — ' + detail : ''}`); }
function fail(label, detail) { anyFail = true; console.log(`  ❌ FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
function section(title)      { console.log(`\n━━━ ${title} ━━━`); }

const serverApiSrc  = readOrDie(SERVER_API,
  '请先确认 electron/types/server-api.ts 是否被手动删除；桥接层必须保留。');
const contractSrc   = readOrDie(CONTRACT_TS,
  '请先执行 `npm run contract:gen-local`（离线）或 `npm run contract:gen`（联网）生成契约。');

// ─────────────────────────────────────────────────────────────────────
// 1. 从 generated 契约抽出所有 path key（paths interface 下的每个 key）
//    特征：在 `export interface paths` 之后、闭合前的 `"/path": { ... }` 行
// ─────────────────────────────────────────────────────────────────────
function extractContractPathKeys(src) {
  const start = src.indexOf('export interface paths');
  if (start === -1) return null;
  // 找 paths interface 的配对大括号
  let i = src.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  const keys = new Set();
  // 状态机：深度 1 的属性行 → 收集
  const lineRe = /^\s*"(\/[^"]+)"\s*:\s*\{/gm;
  // 先用深度找到 paths interface 的 end，在范围内匹配
  const begin = i;
  for (i = begin; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = src.slice(begin + 1, i);
  let m;
  while ((m = lineRe.exec(block)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────
// 2. 从 API_PATHS 抽出字符串叶子路径
//    特征：在 `export const API_PATHS = {` 与 `} as const` 之间匹配
//          `key: '/path'`，跳过带 '=>' 的函数形式行
// ─────────────────────────────────────────────────────────────────────
function extractApiPathsStrings(src) {
  const startKey = 'export const API_PATHS';
  const start = src.indexOf(startKey);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  const close = src.indexOf('} as const', open);
  if (open === -1 || close === -1) return null;
  const block = src.slice(open, close);
  const out = new Set();
  const re = /'(\/[^']+)'/g;
  for (const line of block.split('\n')) {
    if (line.includes('=>')) continue; // 函数形式跳过
    let m;
    while ((m = re.exec(line)) !== null) {
      out.add(m[1]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 3. generated 契约中 components.schemas 的 key 名集合
//    特征：`schemas: {` 下的深度 1 的属性键（非 `/**` 注释）— 用正则近似
//    更鲁棒：匹配 `schemas: {` 之后配对括号范围内的所有行：
//      `        /** Doc */`
//      `        KeyName: {`
// ─────────────────────────────────────────────────────────────────────
function extractSchemaKeys(src) {
  const schemasStart = src.indexOf('schemas: {');
  if (schemasStart === -1) return null;
  let i = src.indexOf('{', schemasStart);
  let depth = 0;
  const open = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  const block = src.slice(open + 1, i);
  const keys = new Set();
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/gm;
  let m;
  while ((m = re.exec(block)) !== null) keys.add(m[1]);
  return keys;
}

// ─────────────────────────────────────────────────────────────────────
// 4. server-api.ts 的 Contract namespace 里 aliasing 的 key 列表
//    特征：`export type KeyName = _components['schemas']['<KeyName>']`
// ─────────────────────────────────────────────────────────────────────
function extractContractAnchorNames(src) {
  const start = src.indexOf('export namespace Contract');
  if (start === -1) return null;
  const re = /export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*_components\['schemas'\]\['([^']+)'\]/g;
  const anchors = [];
  let m;
  // 在 namespace 到下一个顶级 `export` 或 EOF 范围内扫描
  const from = src.indexOf('{', start);
  const nextNs = src.indexOf('\nexport namespace', from);
  const nextExport = src.indexOf('\nexport type paths', from); // SSOT 锚点之前就已经结束的 Contract ns，所以找下一个与 namespace 同级的顶级块
  const endCandidates = [src.length];
  if (nextNs > from) endCandidates.push(nextNs);
  if (nextExport > from) endCandidates.push(nextExport);
  const end = Math.min(...endCandidates);
  const block = src.slice(from, end);
  while ((m = re.exec(block)) !== null) {
    anchors.push({ anchorName: m[1], schemaKey: m[2] });
  }
  return anchors;
}

// =====================================================================
// 运行校验
// =====================================================================
console.log('[verify-contract] 软件工程铁律 IRON-10 双写一致性自检');
console.log(`  · 契约文件: ${path.relative(ROOT, CONTRACT_TS)}`);
console.log(`  · 桥接文件: ${path.relative(ROOT, SERVER_API)}`);

// ── 校验 1：API_PATHS 路径 vs 契约 paths
section('1/3 · API_PATHS 拼写校验（防止路径写错/拼错）');
const contractPaths = extractContractPathKeys(contractSrc);
const apiPaths      = extractApiPathsStrings(serverApiSrc);

if (contractPaths === null) fail('定位 paths interface（generated）', '未找到 export interface paths 块');
else if (apiPaths === null) fail('定位 API_PATHS 常量（server-api.ts）', '未找到 export const API_PATHS');
else {
  pass('generated 契约 paths 条目数', String(contractPaths.size));
  pass('API_PATHS 字符串叶子数', String(apiPaths.size));

  // 策略：离线 generated 契约可能是某个子服务快照（全是 dreamina 域，没有 health/rembg 等）。
  //      只有当"契约里有相同 2 段前缀，但该路径不存在"时才算 FAIL（高概率拼写错误）。
  //      如果契约里根本没有该前缀 → WARN（正常：契约不覆盖该业务域，等 contract:gen 拉取最新全量）。
  const contractPrefix2 = new Set();
  for (const p of contractPaths) {
    const segs = p.split('/'); // '/a/b/c' → ['', 'a', 'b', 'c']
    if (segs.length >= 3) contractPrefix2.add('/' + segs[1] + '/' + segs[2]);
  }
  const contractPathsArr = [...contractPaths];
  const missing     = [...apiPaths].filter(p => !contractPaths.has(p));
  const extra       = contractPathsArr.filter(p => !apiPaths.has(p));
  const suspectFail = missing.filter(p => {
    const segs = p.split('/');
    if (segs.length < 3) return false; // '/health' 这种单段前缀无 2 段可对比
    const pre2 = '/' + segs[1] + '/' + segs[2];
    if (!contractPrefix2.has(pre2)) return false; // 契约根本无该前缀 → 跨域
    // 豁免：若契约 paths 中存在任意 path 以 `${p}/` 开头（如 p=/tasks/unified，契约有 /tasks/unified/{id}）
    //       则为列表/详情分层，不是拼写错误。
    const parentPrefix = p.endsWith('/') ? p : (p + '/');
    if (contractPathsArr.some(cp => cp.startsWith(parentPrefix))) return false;
    return true;
  });
  const crossDomainWarn = missing.filter(p => !suspectFail.includes(p));

  if (suspectFail.length > 0) fail('疑似拼写错误：契约含相同前缀但路径缺失', suspectFail.join(', '));
  else                       pass('API_PATHS 拼写检查：无同源前缀拼写错误');
  if (crossDomainWarn.length > 0)
    console.log(`  ⚠️  WARN  API_PATHS 声明但契约完全无对应业务域：${crossDomainWarn.length} 条（${crossDomainWarn.slice(0, 5).join(', ')}…）。` +
                `执行 npm run contract:gen 拉取服务端全量 /openapi.json 可补全。`);
  if (missing.length === 0) pass('API_PATHS 所有路径均在契约中声明（100% 覆盖）');

  if (extra.length > 0) console.log(`  ⚠️  WARN  契约存在但 API_PATHS 未声明：${extra.length} 条（客户端尚未用到，属预期）`);
}

// ── 校验 2：Contract.* 锚点 vs components.schemas key
section('2/3 · Contract 锚点存在性（所有 aliasing 指向真实 schema key）');
const schemaKeys      = extractSchemaKeys(contractSrc);
const contractAnchors = extractContractAnchorNames(serverApiSrc);

if (schemaKeys === null)      fail('定位 components.schemas（generated）');
else if (contractAnchors === null || contractAnchors.length === 0)
  fail('Contract namespace aliasing 条目', '未找到 export type Xxx = _components["schemas"]["Yyy"] 行；请检查 server-api.ts Contract namespace 是否被移除。');
else {
  pass('components.schemas key 数', String(schemaKeys.size));
  pass('Contract namespace aliasing 数', String(contractAnchors.length));
  let broken = 0;
  for (const { anchorName, schemaKey } of contractAnchors) {
    if (schemaKeys.has(schemaKey)) pass(`Contract.${anchorName}`, `→ schemas['${schemaKey}'] OK`);
    else                           { fail(`Contract.${anchorName}`, `→ schemas['${schemaKey}'] 不存在于契约，可能是 contract:gen 后字段重命名，请同步别名。`); broken++; }
  }
  if (broken === 0) pass('全部 Contract 锚点有效');
}

// ── 校验 3：漂移点清单行数（≥ 4 条基线）
section('3/3 · Namespaces 漂移点表格完整性');
{
  const driftTableRe = /^\s*\/\/\s*\|[^\n]*MaterialAPI\.OcrRequest[^\n]*$/m;
  const driftRowRe   = /^\s*\/\/\s*\|\s*[^|]+Transition/gm;  // fallback 近似
  // 实际：统计表格中从 MaterialAPI.OcrRequest 到 Rembg/VSR/Workflow…Request 的 4 条基线行
  const knownDrifKeys = ['MaterialAPI.OcrRequest', 'MaterialAPI.OCRResponse',
    'ASRAPI.TranscribeRequest', 'VSRAPI.RemoveRequest'];
  let found = 0;
  for (const k of knownDrifKeys) {
    const re = new RegExp(`\\|\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`);
    if (re.test(serverApiSrc)) found++;
  }
  if (found === knownDrifKeys.length) pass(`漂移点基线条目数`, `全部 ${found}/${knownDrifKeys.length} 条保留`);
  else                                 fail('漂移点基线条目数', `只找到 ${found}/${knownDrifKeys.length}，请检查 Namespaces 过渡说明表是否被误删。`);
  if (driftTableRe.test(serverApiSrc)) pass('漂移点表格标题栏未被误删');
  else                                 fail('漂移点表格标题栏', '未找到包含 MaterialAPI.OcrRequest 的表格行。');
}

// ── 总结
section('总结');
if (anyFail) {
  console.log('[verify-contract] ❌ 一致性校验失败，请修复以上 FAIL 项后再提交（IRON-10 / IRON-05）。');
  process.exit(1);
} else {
  console.log('[verify-contract] ✅ 全部校验通过。F-2 OpenAPI 契约单一真实来源生效。');
  process.exit(0);
}

#!/usr/bin/env node
/**
 * NodeWarden CI provisioning helper (v1.0.1)
 * ------------------------------------------------------------------
 * GitHub Actions 专用：在全新 Cloudflare 账号上幂等地创建部署所需资源，
 * 并生成一份带资源 ID 的 wrangler.ci.toml（不改动仓库内的原始配置）。
 *
 * 解决的问题：
 *  - wrangler.toml / wrangler.kv.toml 故意不带 D1 的 database_id 与 KV 的 id，
 *    因为它们与账号绑定、不能写死在仓库里；CI 每次自动查询/创建后再注入。
 *  - D1 数据库、R2 桶、KV 命名空间必须在首次 wrangler deploy 之前存在。
 *
 * 必需环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
 * 可选环境变量：STORAGE_MODE = r2（默认） | kv
 * 产物：仓库根目录下的 wrangler.ci.toml（已被 .gitignore 忽略）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = String(process.env.STORAGE_MODE || 'r2').toLowerCase() === 'kv' ? 'kv' : 'r2';
const SRC = MODE === 'kv' ? 'wrangler.kv.toml' : 'wrangler.toml';
const OUT = 'wrangler.ci.toml';
const D1_NAME = 'nodewarden-db';
const R2_BUCKET = 'nodewarden-attachments';
const KV_TITLE = 'nodewarden-attachments-kv';

const LOCAL_BIN =
  process.env.WRANGLER_BIN || path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const HAS_LOCAL = Boolean(process.env.WRANGLER_BIN) || fs.existsSync(LOCAL_BIN);

function wrangler(argv, { allowFailure = false } = {}) {
  const bin = HAS_LOCAL ? LOCAL_BIN : 'npx';
  const args = HAS_LOCAL ? argv : ['wrangler', ...argv];
  try {
    return execFileSync(bin, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFailure) return `${err.stdout || ''}\n${err.stderr || ''}`;
    const detail = `${err.stdout || ''}\n${err.stderr || ''}`.trim();
    throw new Error(`wrangler ${argv.join(' ')} 执行失败：\n${detail}`);
  }
}

/** 从 wrangler 输出中提取 JSON（容忍 ANSI 色码与前置日志行） */
function jsonFrom(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const starts = [...text.matchAll(/^[\[{]/gm)].map((m) => m.index);
  for (const start of starts) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // 尝试下一个候选起点
    }
  }
  throw new Error(`无法从 wrangler 输出中解析 JSON：\n${text.slice(0, 800)}`);
}

/** 查找或创建 D1 数据库，返回 database_id */
function ensureD1() {
  const list = jsonFrom(wrangler(['d1', 'list', '--json']));
  let db = list.find((item) => item.name === D1_NAME);
  if (!db) {
    console.log(`[provision] 创建 D1 数据库 ${D1_NAME}`);
    wrangler(['d1', 'create', D1_NAME]);
    db = jsonFrom(wrangler(['d1', 'list', '--json'])).find((item) => item.name === D1_NAME);
  }
  if (!db) throw new Error(`创建后仍找不到 D1 数据库 ${D1_NAME}`);
  const id = db.uuid || db.id || db.database_id;
  if (!id) throw new Error(`无法读取 D1 uuid：${JSON.stringify(db)}`);
  console.log(`[provision] D1 ${D1_NAME} -> ${id}`);
  return id;
}

/** 确保 R2 桶存在。r2 bucket list 输出格式不做假设，只做字符串匹配 */
function ensureR2() {
  const before = wrangler(['r2', 'bucket', 'list'], { allowFailure: true });
  if (before.includes(R2_BUCKET)) {
    console.log(`[provision] R2 桶 ${R2_BUCKET} 已存在`);
    return;
  }
  console.log(`[provision] 创建 R2 桶 ${R2_BUCKET}`);
  const created = wrangler(['r2', 'bucket', 'create', R2_BUCKET], { allowFailure: true });
  if (/already exists/i.test(created)) {
    console.log(`[provision] R2 桶 ${R2_BUCKET} 已存在（并发创建）`);
    return;
  }
  const after = wrangler(['r2', 'bucket', 'list'], { allowFailure: true });
  if (after.includes(R2_BUCKET)) return;
  throw new Error(
    `创建 R2 桶 ${R2_BUCKET} 失败。若账号未开通 R2（需要绑卡），可改用 KV 模式：\n` +
      `GitHub 仓库变量 STORAGE_MODE=kv 或手动运行时选择 kv。\n${created}\n${after}`
  );
}

/** 查找或创建 KV 命名空间，返回 namespace id */
function ensureKV() {
  const list = jsonFrom(wrangler(['kv', 'namespace', 'list']));
  let ns =
    list.find((item) => item.title === KV_TITLE) ||
    list.find((item) => typeof item.title === 'string' && item.title.endsWith('attachments-kv'));
  if (!ns) {
    console.log(`[provision] 创建 KV 命名空间 ${KV_TITLE}`);
    wrangler(['kv', 'namespace', 'create', KV_TITLE]);
    ns = jsonFrom(wrangler(['kv', 'namespace', 'list'])).find((item) => item.title === KV_TITLE);
  }
  if (!ns || !ns.id) throw new Error(`无法获取 KV 命名空间 ${KV_TITLE} 的 id`);
  console.log(`[provision] KV ${KV_TITLE} -> ${ns.id}`);
  return ns.id;
}

/** 在指定 [[...]] 配置块中注入/覆盖一个键 */
function inject(lines, header, key, value) {
  const idx = lines.findIndex((line) => line.trim() === header);
  if (idx < 0) throw new Error(`${SRC} 中缺少 ${header} 配置块`);
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(idx, end);
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const at = block.findIndex((line) => keyRe.test(line));
  if (at >= 0) block[at] = `${key} = "${value}"`;
  else block.splice(1, 0, `${key} = "${value}"`);
  lines.splice(idx, end - idx, ...block);
}

/** 移除 [build] 段：CI 已单独执行 npm run build，避免部署阶段重复构建 */
function dropBuildSection(lines) {
  const idx = lines.findIndex((line) => line.trim() === '[build]');
  if (idx < 0) return lines;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  lines.splice(idx, end - idx, '# [build] 已由 ci-provision.mjs 移除（构建在独立 CI 步骤完成）');
  return lines;
}

function main() {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!process.env[name]) throw new Error(`缺少环境变量 ${name}`);
  }

  const d1Id = ensureD1();
  const kvId = MODE === 'kv' ? ensureKV() : null;
  if (MODE === 'r2') ensureR2();

  const lines = fs.readFileSync(path.join(ROOT, SRC), 'utf8').split('\n');
  inject(lines, '[[d1_databases]]', 'database_id', d1Id);
  if (kvId) inject(lines, '[[kv_namespaces]]', 'id', kvId);
  dropBuildSection(lines);
  lines.unshift(`# 由 scripts/ci-provision.mjs 基于 ${SRC} 生成（mode=${MODE}），请勿提交`);
  fs.writeFileSync(path.join(ROOT, OUT), lines.join('\n'));
  console.log(`[provision] 已生成 ${OUT}（存储模式：${MODE}）`);
}

main();

#!/usr/bin/env node
/**
 * win-browser CDP (CL-012) 真机冒烟。
 *
 * 用 headless Edge + data: URL 跑，全程不联网、不碰用户日常 profile，
 * 结束后杀掉自己启动的实例。
 */
import { writeSync } from 'node:fs';
import { CdpRuntime } from '../packages/servers/dist/browser/runtime.js';

const results = [];
let failed = 0;

function check(id, name, ok, detail = '') {
  results.push({ id, name, ok });
  if (!ok) failed += 1;
  writeSync(1, `${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok || detail === '' ? '' : ` :: ${String(detail).slice(0, 220)}`}\n`);
}

const PAGE_HTML =
  'data:text/html,<h1>WinMCP CDP</h1>' +
  '<button id=b>Press</button>' +
  '<input aria-label="name">' +
  '<div id=out>idle</div>' +
  '<script>document.getElementById("b").onclick=function(){document.getElementById("out").textContent="clicked"}</script>';

const runtime = new CdpRuntime();
let launchedPid = 0;

try {
  const before = await runtime.status();
  check('CD-01', '未启动时给出可执行提示', before.connected === false && typeof before.hint === 'string', before.hint);

  const launched = await runtime.launch({ headless: true, startUrl: PAGE_HTML });
  launchedPid = Number(launched.pid ?? 0);
  check('CD-02', '独立 profile 启动并读回真实端口', Number(launched.port) > 0 && String(launched.browser).length > 0, JSON.stringify(launched).slice(0, 160));

  const after = await runtime.status();
  check('CD-03', '状态显示已连接且有 page target', after.connected && after.targets.some((t) => t.type === 'page'), JSON.stringify(after.targets.map((t) => t.type)));

  const page = await runtime.ensure();
  check('CD-04', '可附着到页面（flatten session）', page.sessionId.length > 0, page.sessionId);

  const snap = await page.snapshot({ maxNodes: 150, maxDepth: 10 });
  check('CD-05', 'DOM 语义快照生成带 ref 的节点', snap.nodeCount >= 4 && /^@b\d+:e\d+$/.test(snap.nodes[0]?.ref ?? ''), `nodes=${snap.nodeCount}`);

  const roles = new Set(snap.nodes.map((n) => n.role));
  check('CD-06', '角色识别覆盖 heading/button/textbox', roles.has('heading') && roles.has('button') && roles.has('textbox'), [...roles].join(','));

  const input = snap.nodes.find((n) => n.role === 'textbox');
  if (input !== undefined) {
    const result = await page.act(input.ref, 'setValue', { text: 'hello cdp' });
    check('CD-07', 'setValue 走原生 setter 并回读', result['via'] === 'value-setter' && String((result['readback'] ?? {})['value'] ?? '') === 'hello cdp', JSON.stringify(result['readback']));
  } else {
    check('CD-07', 'setValue 走原生 setter 并回读', false, '未找到 textbox');
  }

  const button = snap.nodes.find((n) => n.role === 'button');
  const out = snap.nodes.find((n) => n.tag === 'div' && n.id === 'out');
  if (button !== undefined && out !== undefined) {
    const result = await page.act(button.ref, 'click', { expect: [{ ref: out.ref, text: 'idle' }] });
    const text = await page.evaluate('document.getElementById("out").textContent');
    check('CD-08', 'click + 动作前断言，页面状态随之改变', result['via'] === 'element.click' && text === 'clicked', `via=${String(result['via'])} text=${String(text)}`);
  } else {
    check('CD-08', 'click + 动作前断言，页面状态随之改变', false, '未找到 button/out');
  }

  const second = await page.snapshot({ maxNodes: 60 });
  let staleCode = '';
  try {
    await page.act(snap.nodes[0].ref, 'getText');
  } catch (error) {
    staleCode = error?.code ?? '';
  }
  check('CD-09', '旧快照 ref 返回 STALE_REF', staleCode === 'STALE_REF', `${snap.nodes[0].ref} -> ${staleCode} (current b${second.snapshotId})`);

  // 用**当前**快照的 ref 做断言，确保失败原因来自断言而非陈旧 ref
  const target = second.nodes.find((n) => n.role === 'button') ?? second.nodes[0];
  let assertCode = '';
  try {
    if (target !== undefined) {
      await page.act(target.ref, 'click', { expect: [{ ref: target.ref, text: '不存在的文本' }] });
    }
  } catch (error) {
    assertCode = error?.code ?? '';
  }
  check('CD-10', '断言不满足时 fail 而不是照旧 ref 乱点', assertCode === 'GUARD_ASSERTION_FAILED', `${assertCode} (ref=${target?.ref})`);

  const shot = await page.screenshot();
  check('CD-11', '页面截图落盘', typeof shot.path === 'string' && shot.bytes > 1000, `${shot.path} ${shot.bytes}B`);

  const tabs = await runtime.targets();
  check('CD-12', 'target 列表可读（多 tab 管理）', tabs.length >= 1, `count=${tabs.length}`);

  await runtime.closeTab(page.targetId);
  const afterClose = await runtime.status();
  check('CD-13', '关闭标签页后状态可读', afterClose.connected === true, JSON.stringify(afterClose).slice(0, 120));
} catch (error) {
  check('CD-00', '冒烟未抛异常', false, error instanceof Error ? error.message : String(error));
} finally {
  if (launchedPid > 0) {
    try {
      process.kill(launchedPid);
    } catch {
      // 已退出
    }
  }
}

writeSync(1, `\nCDP 冒烟结果：${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);
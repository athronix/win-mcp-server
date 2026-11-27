/**
 * 页面级 CDP 控制器：语义快照 / 按 ref 动作 / 断言 / 截图
 *
 * ref 语义与 desktop 一致（`@b<N>:e<M>`），但存的是页内数组下标：
 * - 页面导航会清空 `window.__wmcRefs`，旧 ref 直接 STALE_REF（这就是想要的行为）
 * - 每次动作前用 tag + 文本指纹复核，DOM 被框架重建时同样判 STALE_REF
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, CdpError, listTargets, type CdpTarget } from './cdp.js';

export interface CdpNode {
  ref: string;
  role: string;
  name: string;
  depth: number;
  states: string[];
  actions: string[];
  value: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  tag: string;
  id: string;
}

export interface SnapshotResult {
  snapshotId: number;
  url: string;
  title: string;
  nodes: CdpNode[];
  nodeCount: number;
  truncated: boolean;
  capturedAt: string;
  refHint: string;
}

export interface ActOptions {
  text?: string;
  expect?: ExpectCondition[];
}

export interface ExpectCondition {
  ref: string;
  exists?: boolean;
  text?: string;
  value?: string;
  checked?: boolean;
  attribute?: { name: string; value: string };
}

export type ActAction =
  | 'click'
  | 'setValue'
  | 'focus'
  | 'scrollIntoView'
  | 'getText'
  | 'selectOption'
  | 'submit';

const SNAPSHOT_SCRIPT = (maxNodes: number, maxDepth: number): string => `
(() => {
  const MAXN = ${maxNodes};
  const MAXD = ${maxDepth};
  const root = document.body || document.documentElement;
  if (!root) return { nodes: [], truncated: false, url: location.href, title: document.title };

  const isHidden = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    const rect = el.getBoundingClientRect();
    return rect.width <= 1 || rect.height <= 1;
  };
  const ROLE = { a:'link', button:'button', select:'combobox', textarea:'textbox', img:'img',
    h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading',
    ul:'list', ol:'list', li:'listitem', table:'table', tr:'row', td:'cell', th:'columnheader',
    nav:'navigation', main:'main', header:'banner', footer:'contentinfo', form:'form',
    label:'text', p:'text', span:'text', div:'generic', section:'region', article:'article',
    dialog:'dialog', iframe:'iframe', video:'video', canvas:'canvas' };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE[tag] || tag;
  };
  const nameOf = (el) => {
    const candidates = ['aria-label', 'placeholder', 'alt', 'title'];
    for (const attr of candidates) {
      const value = el.getAttribute(attr);
      if (value && value.trim().length > 0) return value.trim().slice(0, 160);
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 160);
  };
  const statesOf = (el) => {
    const out = [];
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) out.push('checked'); }
    else if (el.getAttribute('aria-checked') === 'true') out.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') out.push('expanded');
    if (el.getAttribute('aria-selected') === 'true' || el.selected === true) out.push('selected');
    if (el.readOnly === true) out.push('readonly');
    if (el.required === true) out.push('required');
    if (document.activeElement === el) out.push('focused');
    return out;
  };
  const actionsOf = (el, role) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const clickable = ['button','link','tab','menuitem','option','checkbox','radio','switch','treeitem'];
    if (clickable.indexOf(role) >= 0) out.push('click');
    if (tag === 'a' && el.getAttribute('href')) out.push('click');
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') out.push('click');
      else out.push('setValue', 'focus');
    }
    if (tag === 'textarea') out.push('setValue', 'focus');
    if (tag === 'select') out.push('selectOption');
    if (el.getAttribute('contenteditable') === 'true') out.push('setValue', 'focus');
    out.push('scrollIntoView');
    if (nameOf(el).length > 0) out.push('getText');
    if (tag === 'form') out.push('submit');
    return out.filter((value, index) => out.indexOf(value) === index);
  };

  const refs = [];
  const nodes = [];
  let truncated = false;

  const walk = (el, depth) => {
    if (nodes.length >= MAXN) { truncated = true; return; }
    if (depth > MAXD) return;
    if (isHidden(el)) return;
    const role = roleOf(el);
    const name = nameOf(el);
    const actions = actionsOf(el, role);
    const interesting = name.length > 0 || actions.length > 0 || role !== 'generic';
    let nextDepth = depth;
    if (interesting) {
      const rect = el.getBoundingClientRect();
      refs.push(el);
      nodes.push({
        ref: refs.length - 1,
        role,
        name,
        depth,
        states: statesOf(el),
        actions,
        value: typeof el.value === 'string' ? el.value.slice(0, 200) : '',
        bounds: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height)
        },
        tag: el.tagName.toLowerCase(),
        id: el.id || ''
      });
      nextDepth = depth + 1;
    }
    for (const child of el.children) walk(child, nextDepth);
  };

  walk(root, 0);
  window.__wmcRefs = refs;
  window.__wmcGen = (window.__wmcGen || 0) + 1;
  return { nodes, truncated, url: location.href, title: document.title };
})()
`;

const RESOLVE_SCRIPT = (index: number): string => `
(() => {
  const refs = window.__wmcRefs;
  if (!refs) return { ok: false, reason: 'no-snapshot' };
  const el = refs[${index}];
  if (!el) return { ok: false, reason: 'no-snapshot' };
  if (!el.isConnected) return { ok: false, reason: 'detached' };
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    text: ((el.innerText || el.value || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  };
})()
`;

const ACT_SCRIPT = (index: number, action: string, text: string): string => `
(() => {
  const refs = window.__wmcRefs;
  if (!refs) return { ok: false, reason: 'no-snapshot' };
  const el = refs[${index}];
  if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
  const payload = ${JSON.stringify(text)};
  const tag = el.tagName.toLowerCase();
  const fire = (type) => { el.dispatchEvent(new Event(type, { bubbles: true })); };
  const declared = ${JSON.stringify(action)};

  try {
    if (declared === 'click') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, via: 'element.click' };
    }
    if (declared === 'setValue') {
      el.scrollIntoView({ block: 'center' });
      if (tag === 'input' || tag === 'textarea') {
        el.focus();
        const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, payload);
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = payload;
      } else {
        return { ok: false, reason: 'not-editable' };
      }
      fire('input');
      fire('change');
      return { ok: true, via: 'value-setter', value: (el.value || '').slice(0, 120) };
    }
    if (declared === 'focus') { el.focus(); return { ok: true, via: 'focus' }; }
    if (declared === 'scrollIntoView') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return { ok: true, via: 'scroll-into-view' };
    }
    if (declared === 'getText') {
      return { ok: true, text: ((el.innerText || el.value || '') + '').slice(0, 4000) };
    }
    if (declared === 'selectOption') {
      if (tag !== 'select') return { ok: false, reason: 'not-select' };
      el.value = payload;
      fire('input');
      fire('change');
      return { ok: true, via: 'value', value: el.value };
    }
    if (declared === 'submit') {
      const form = tag === 'form' ? el : el.closest('form');
      if (!form) return { ok: false, reason: 'no-form' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
      return { ok: true, via: 'requestSubmit' };
    }
    return { ok: false, reason: 'unsupported-action' };
  } catch (error) {
    return { ok: false, reason: 'exception', message: String(error) };
  }
})()
`;

const EXPECT_SCRIPT = (conditions: { index: number; condition: Omit<ExpectCondition, 'ref'> }[]): string => `
(() => {
  const refs = window.__wmcRefs;
  const conditions = ${JSON.stringify(conditions)};
  const failures = [];
  for (const entry of conditions) {
    const el = refs ? refs[entry.index] : undefined;
    const condition = entry.condition;
    const label = 'e' + entry.index;
    if (condition.exists === true && (!el || !el.isConnected)) { failures.push(label + ': 元素不存在'); continue; }
    if (!el || !el.isConnected) continue;
    const text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim();
    if (typeof condition.text === 'string' && text.indexOf(condition.text) < 0) {
      failures.push(label + ': 文本不含 ' + JSON.stringify(condition.text));
    }
    if (typeof condition.value === 'string' && String(el.value || '') !== condition.value) {
      failures.push(label + ': value 不是 ' + JSON.stringify(condition.value));
    }
    if (typeof condition.checked === 'boolean' && Boolean(el.checked) !== condition.checked) {
      failures.push(label + ': checked 不是 ' + condition.checked);
    }
    if (condition.attribute) {
      const actual = el.getAttribute(condition.attribute.name);
      if (actual !== condition.attribute.value) {
        failures.push(label + ': 属性 ' + condition.attribute.name + ' 不是 ' + JSON.stringify(condition.attribute.value));
      }
    }
  }
  return { ok: failures.length === 0, failures };
})()
`;

interface EvaluationResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export class PageController {
  readonly #client: CdpClient;
  readonly #sessionId: string;
  readonly targetId: string;
  #snapshotSeq = 0;
  #url = '';

  private constructor(client: CdpClient, sessionId: string, targetId: string) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.targetId = targetId;
  }

  static async attach(client: CdpClient, targetId: string): Promise<PageController> {
    const attached = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new PageController(client, attached.sessionId, targetId);
    await page.#client.send('Page.enable', {}, { sessionId: page.#sessionId });
    await page.#client.send('Runtime.enable', {}, { sessionId: page.#sessionId });
    return page;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get url(): string {
    return this.#url;
  }

  async evaluate<T>(expression: string, timeoutMs = 20_000): Promise<T> {
    const raw =
      (await this.#client.send<EvaluationResult>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        { sessionId: this.#sessionId, timeoutMs },
      )) ?? {};
    if (raw.exceptionDetails !== undefined) {
      const detail = raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? '未知异常';
      throw new CdpError('CDP_EVAL_FAILED', detail.split('\n')[0] ?? detail);
    }
    return raw.result?.value as T;
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<{ url: string; title: string }> {
    await this.#client.send('Page.navigate', { url }, { sessionId: this.#sessionId, timeoutMs });
    // 等 load 事件；超时不代表失败（可能是 SPA 长轮询），由调用方决定是否重试
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), Math.min(timeoutMs, 15_000));
      if (typeof timer.unref === 'function') timer.unref();
      const listener = (_params: Record<string, unknown>, sessionId?: string): void => {
        if (sessionId !== undefined && sessionId !== this.#sessionId) return;
        clearTimeout(timer);
        resolve();
      };
      this.#client.on('Page.loadEventFired', listener);
    });
    const info = await this.evaluate<{ url: string; title: string }>(
      '({ url: location.href, title: document.title })',
    );
    this.#url = info.url;
    return info;
  }

  async snapshot(options: { maxNodes?: number; maxDepth?: number } = {}): Promise<SnapshotResult> {
    const maxNodes = options.maxNodes ?? 600;
    const maxDepth = options.maxDepth ?? 12;
    interface RawNode {
      ref: number;
      role: string;
      name: string;
      depth: number;
      states: string[];
      actions: string[];
      value: string;
      bounds: { x: number; y: number; width: number; height: number } | null;
      tag: string;
      id: string;
    }
    const raw =
      (await this.evaluate<{
        nodes: RawNode[];
        truncated: boolean;
        url: string;
        title: string;
      }>(SNAPSHOT_SCRIPT(maxNodes, maxDepth))) ?? { nodes: [], truncated: false, url: '', title: '' };

    this.#snapshotSeq += 1;
    const snapshotId = this.#snapshotSeq;
    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    this.#url = raw.url ?? '';

    return {
      snapshotId,
      url: raw.url ?? '',
      title: raw.title ?? '',
      nodes: rawNodes.map((node) => ({ ...node, ref: formatBrowserRef(snapshotId, node.ref) })),
      nodeCount: rawNodes.length,
      truncated: raw.truncated === true,
      capturedAt: new Date().toISOString(),
      refHint: `refs are only valid for snapshot b${snapshotId};导航或 DOM 重建后必须重新快照`,
    };
  }

  async act(ref: string, action: ActAction, options: ActOptions = {}): Promise<Record<string, unknown>> {
    const parsed = parseBrowserRef(ref);
    if (parsed === null) {
      throw new CdpError('INVALID_PARAMS', `ref 必须形如 @b3:e12（收到 '${ref}'）`);
    }
    if (parsed.snapshotId !== this.#snapshotSeq) {
      throw new CdpError(
        'STALE_REF',
        `ref ${ref} 属于快照 b${parsed.snapshotId}，当前是 b${this.#snapshotSeq}；请重新快照`,
      );
    }

    if (options.expect !== undefined && options.expect.length > 0) {
      const conditions = options.expect.map((condition) => {
        const expectRef = parseBrowserRef(condition.ref);
        if (expectRef === null) {
          throw new CdpError('INVALID_PARAMS', `expect.ref 非法：'${condition.ref}'`);
        }
        if (expectRef.snapshotId !== this.#snapshotSeq) {
          throw new CdpError('STALE_REF', `expect.ref ${condition.ref} 属于旧快照，请重新快照`);
        }
        const { ref: _ignored, ...rest } = condition;
        return { index: expectRef.index, condition: rest };
      });
      const checked = await this.evaluate<{ ok: boolean; failures: string[] }>(EXPECT_SCRIPT(conditions));
      if (!checked.ok) {
        throw new CdpError('GUARD_ASSERTION_FAILED', `动作前断言失败：${checked.failures.join('；')}`);
      }
    }

    const resolved = await this.evaluate<{ ok: boolean; reason?: string; tag?: string; text?: string }>(
      RESOLVE_SCRIPT(parsed.index),
    );
    if (!resolved.ok) {
      const reason = resolved.reason ?? 'unknown';
      throw new CdpError(
        reason === 'no-snapshot' ? 'STALE_REF' : 'STALE_REF',
        reason === 'no-snapshot'
          ? '页面已导航或未快照，ref 失效；请重新调用 browser.cdp.snapshot'
          : `${ref} 元素已从 DOM 移除，请重新快照`,
      );
    }

    const result = await this.evaluate<{
      ok: boolean;
      reason?: string;
      via?: string;
      value?: string;
      text?: string;
      message?: string;
    }>(ACT_SCRIPT(parsed.index, action, options.text ?? ''));

    if (!result.ok) {
      if (result.reason === 'unsupported-action') {
        throw new CdpError('INVALID_PARAMS', `该元素不支持 ${action}`);
      }
      if (result.reason === 'not-editable' || result.reason === 'not-select' || result.reason === 'no-form') {
        throw new CdpError('INVALID_PARAMS', `该元素不支持 ${action}（原因是 ${result.reason}）`);
      }
      throw new CdpError('STALE_REF', `动作失败：${result.reason}${result.message !== undefined ? ` ${result.message}` : ''}`);
    }

    return {
      ref,
      action,
      via: result.via ?? 'unknown',
      resolved: { tag: resolved.tag ?? '', fingerprint: resolved.text ?? '' },
      readback: { value: result.value ?? '', text: result.text ?? '' },
    };
  }

  async screenshot(): Promise<{ path: string; bytes: number }> {
    const shot = await this.#client.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      { sessionId: this.#sessionId, timeoutMs: 30_000 },
    );
    const buffer = Buffer.from(shot.data, 'base64');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(os.tmpdir(), `win-mcp-web-${stamp}.png`);
    writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  async closeTarget(): Promise<void> {
    await this.#client.send('Target.closeTarget', { targetId: this.targetId });
  }
}

export function formatBrowserRef(snapshotId: number, index: number): string {
  return `@b${snapshotId}:e${index}`;
}

export function parseBrowserRef(value: string): { snapshotId: number; index: number } | null {
  const matched = /^@b(\d+):e(\d+)$/.exec(value);
  if (matched === null) return null;
  return { snapshotId: Number(matched[1]), index: Number(matched[2]) };
}

/** 找到第一个 page 类型 target（跳过 devtools / service worker） */
export function pickPageTarget(targets: readonly CdpTarget[]): CdpTarget | null {
  return targets.find((target) => target.type === 'page') ?? null;
}

export { targetIdOf } from './cdp.js';

export { listTargets };
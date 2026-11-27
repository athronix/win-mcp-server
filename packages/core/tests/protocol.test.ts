import { describe, expect, it } from 'vitest';
import { encodeRequest, parseResponseLine } from '../src/bridge/protocol.js';

describe('CL-002 桥协议编解码', () => {
  it('P-01 编码为单行 JSON + 换行', () => {
    const line = encodeRequest({ id: 'req_1', op: 'ping', params: {} });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ id: 'req_1', op: 'ping', params: {} });
  });

  it('P-02 解析成功响应', () => {
    const response = parseResponseLine('{"id":"req_1","ok":true,"data":{"pong":true},"durationMs":3}');
    expect(response).toMatchObject({ id: 'req_1', ok: true, data: { pong: true }, durationMs: 3 });
  });

  it('P-03 解析失败响应（含 details）', () => {
    const response = parseResponseLine(
      '{"id":"req_2","ok":false,"error":{"code":"TIMEOUT","message":"slow","details":{"ms":5}}}',
    );
    expect(response).toMatchObject({
      id: 'req_2',
      ok: false,
      error: { code: 'TIMEOUT', message: 'slow', details: { ms: 5 } },
    });
  });

  it('P-04 非协议内容一律返回 undefined（横幅/空行/半行 JSON）', () => {
    expect(parseResponseLine('')).toBeUndefined();
    expect(parseResponseLine('PowerShell 7.6.10')).toBeUndefined();
    expect(parseResponseLine('{"id":"req_1","ok":tr')).toBeUndefined();
    expect(parseResponseLine('[1,2,3]')).toBeUndefined();
    expect(parseResponseLine('null')).toBeUndefined();
  });

  it('P-05 结构不合法的响应被拒', () => {
    expect(parseResponseLine('{"ok":true,"data":1}')).toBeUndefined();
    expect(parseResponseLine('{"id":"req_1","ok":false}')).toBeUndefined();
    expect(parseResponseLine('{"id":"req_1","ok":false,"error":{"code":"X"}}')).toBeUndefined();
    expect(parseResponseLine('{"id":"req_1","ok":"yes"}')).toBeUndefined();
  });

  it('P-06 id 为 null 的失败响应可解析（服务端无法定位请求）', () => {
    const response = parseResponseLine(
      '{"id":null,"ok":false,"error":{"code":"BAD_REQUEST","message":"bad json"}}',
    );
    expect(response).toMatchObject({ id: null, ok: false, error: { code: 'BAD_REQUEST' } });
  });
});
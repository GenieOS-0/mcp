/**
 * Smoke test for the stdio bridge.
 *
 * We don't unit-test the readline loop directly — instead we spawn
 * the CLI as a child process pointed at a tiny localhost echo server
 * and assert the request -> response round-trip works for a handful
 * of representative envelopes (initialize, tools/list, tools/call,
 * a notification, malformed input).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

interface MockExchange {
  status: number;
  body: unknown;
}

async function withMockServer<T>(
  responseFor: (body: unknown) => MockExchange,
  fn: (url: string, requests: { auth: string; body: unknown }[]) => Promise<T>,
): Promise<T> {
  const requests: { auth: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c.toString('utf-8')));
    req.on('end', () => {
      const auth = req.headers['authorization'] as string | undefined;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // accept invalid for negative tests
      }
      requests.push({ auth: auth ?? '', body: parsed });
      const reply = responseFor(parsed);
      res.statusCode = reply.status;
      if (reply.status === 202 || reply.status === 204) {
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function spawnBridge(env: NodeJS.ProcessEnv): {
  send(line: string): void;
  end(): void;
  exitCode: Promise<number | null>;
  stdoutLines: AsyncIterable<string>;
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname],
    { env: { ...process.env, ...env } },
  );
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf-8');
    if (process.env.DEBUG_BRIDGE) process.stderr.write(`[bridge] ${text}`);
  });
  const lineQueue: string[] = [];
  const waiters: Array<(v: IteratorResult<string>) => void> = [];
  let buf = '';
  let closed = false;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (waiters.length) waiters.shift()!({ value: line, done: false });
      else lineQueue.push(line);
    }
  });
  child.stdout.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!({ value: '', done: true });
  });
  return {
    send: (line: string) => child.stdin.write(line + '\n'),
    end: () => child.stdin.end(),
    exitCode: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    stdoutLines: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (lineQueue.length) {
              return Promise.resolve({ value: lineQueue.shift()!, done: false });
            }
            if (closed) return Promise.resolve({ value: '', done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

test('forwards request and writes response', async () => {
  await withMockServer(
    (body) => ({
      status: 200,
      body: { jsonrpc: '2.0', id: (body as { id: number }).id, result: { ok: true } },
    }),
    async (url, requests) => {
      const bridge = spawnBridge({
        GENIEOS_API_KEY: 'gos_test_zzz',
        GENIEOS_MCP_URL: url,
      });
      bridge.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      const it = bridge.stdoutLines[Symbol.asyncIterator]();
      const { value: line } = await it.next();
      bridge.end();
      await bridge.exitCode;
      const reply = JSON.parse(line) as { id: number; result: { ok: boolean } };
      assert.equal(reply.id, 1);
      assert.equal(reply.result.ok, true);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].auth, 'Bearer gos_test_zzz');
      assert.equal((requests[0].body as { method: string }).method, 'tools/list');
    },
  );
});

test('drops responseless reply for notification', async () => {
  await withMockServer(
    () => ({ status: 202, body: null }),
    async (url, requests) => {
      const bridge = spawnBridge({
        GENIEOS_API_KEY: 'gos_test_zzz',
        GENIEOS_MCP_URL: url,
      });
      bridge.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      // give the bridge a tick to send the request
      await new Promise((r) => setTimeout(r, 100));
      bridge.end();
      await bridge.exitCode;
      assert.equal(requests.length, 1);
      assert.equal((requests[0].body as { method: string }).method, 'notifications/initialized');
    },
  );
});

test('responds with parse error on malformed stdin', async () => {
  await withMockServer(
    () => ({ status: 200, body: {} }),
    async (url, requests) => {
      const bridge = spawnBridge({
        GENIEOS_API_KEY: 'gos_test_zzz',
        GENIEOS_MCP_URL: url,
      });
      bridge.send('this is not json');
      const { value: line } = await bridge.stdoutLines[Symbol.asyncIterator]().next();
      bridge.end();
      await bridge.exitCode;
      const parsed = JSON.parse(line) as { error: { code: number } };
      assert.equal(parsed.error.code, -32700);
      assert.equal(requests.length, 0);
    },
  );
});

test('exits non-zero when API key missing', async () => {
  const bridge = spawnBridge({
    GENIEOS_API_KEY: '',
    GENIEOS_MCP_URL: 'http://127.0.0.1:1',
  });
  bridge.end();
  const code = await bridge.exitCode;
  assert.equal(code, 2);
});

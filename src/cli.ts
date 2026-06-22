/**
 * `@genie-os/mcp` — stdio launcher for the GenieOS MCP server.
 *
 * Some editors (Claude Desktop, older Cursor builds, certain IDE
 * extensions) only speak the stdio MCP transport. The hosted MCP
 * server lives at `https://mcp.genieos.pro/v1` and speaks the
 * Streamable HTTP transport. This binary bridges the two:
 *
 *   editor  --stdin (ndjson JSON-RPC)-->  this process
 *                                         |
 *                                         v
 *                                         POST mcp.genieos.pro/v1
 *                                         |
 *   editor  <--stdout (ndjson JSON-RPC)-- |
 *
 * Editors install it as:
 *
 *   {
 *     "mcpServers": {
 *       "genieos": {
 *         "command": "npx",
 *         "args": ["-y", "@genie-os/mcp@latest"],
 *         "env": { "GENIEOS_API_KEY": "gos_live_..." }
 *       }
 *     }
 *   }
 *
 * Notifications (no `id`) are forwarded to the server but the
 * response (a 202 with no body) is dropped — JSON-RPC says
 * notifications get no reply.
 *
 * Auth precedence:
 *
 *   1. GENIEOS_API_KEY env var (recommended for editor configs).
 *   2. --api-key flag (handy for local debugging).
 *   3. ~/.genieos/credentials.json `apiKey` field (shared with
 *      the `genie` CLI).
 *
 * Endpoint precedence:
 *
 *   1. GENIEOS_MCP_URL env var.
 *   2. --url flag.
 *   3. https://mcp.genieos.pro/v1
 */
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULT_URL = 'https://mcp.genieos.pro/v1';

interface Config {
  url: string;
  apiKey: string;
}

function parseArgs(argv: string[]): { apiKey?: string; url?: string; help?: boolean } {
  const out: { apiKey?: string; url?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--api-key' || a === '--apiKey') out.apiKey = argv[++i];
    else if (a.startsWith('--api-key=')) out.apiKey = a.slice('--api-key='.length);
    else if (a === '--url') out.url = argv[++i];
    else if (a.startsWith('--url=')) out.url = a.slice('--url='.length);
  }
  return out;
}

function loadCredentialsFile(): { apiKey?: string; url?: string } {
  try {
    const p = join(homedir(), '.genieos', 'credentials.json');
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as { apiKey?: string; mcpUrl?: string };
    return { apiKey: parsed.apiKey, url: parsed.mcpUrl };
  } catch {
    return {};
  }
}

function resolveConfig(argv: string[]): Config {
  const args = parseArgs(argv);
  if (args.help) {
    process.stderr.write(
      [
        'genieos-mcp — stdio bridge to https://mcp.genieos.pro/v1',
        '',
        'Usage: genieos-mcp [--api-key=gos_live_...] [--url=https://mcp.genieos.pro/v1]',
        '',
        'Reads JSON-RPC envelopes (ndjson) from stdin and prints responses to stdout.',
        '',
        'Environment:',
        '  GENIEOS_API_KEY      Bearer token.',
        '  GENIEOS_MCP_URL      Override the MCP endpoint.',
        '',
        'Credentials file: ~/.genieos/credentials.json',
        '  { "apiKey": "gos_live_...", "mcpUrl": "https://..." }',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }
  const file = loadCredentialsFile();
  const apiKey =
    process.env.GENIEOS_API_KEY?.trim() ||
    args.apiKey?.trim() ||
    file.apiKey?.trim() ||
    '';
  const url =
    process.env.GENIEOS_MCP_URL?.trim() ||
    args.url?.trim() ||
    file.url?.trim() ||
    DEFAULT_URL;
  if (!apiKey) {
    process.stderr.write(
      'genieos-mcp: missing API key. Set GENIEOS_API_KEY or use --api-key.\n',
    );
    process.exit(2);
  }
  return { apiKey, url };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

async function forward(cfg: Config, msg: JsonRpcMessage): Promise<JsonRpcMessage | null> {
  const isNotification = !('id' in msg) || msg.id === undefined;
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'User-Agent': 'genieos-mcp-stdio/0.1',
      },
      body: JSON.stringify(msg),
    });
  } catch (e) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: {
        code: -32099,
        message: `Network error reaching ${cfg.url}: ${(e as Error).message}`,
      },
    } as JsonRpcMessage;
  }
  if (res.status === 202 || res.status === 204) {
    return null;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: {
        code: -32603,
        message: `Non-JSON response from MCP server (status ${res.status})`,
      },
    } as JsonRpcMessage;
  }
}

async function main(): Promise<void> {
  const cfg = resolveConfig(process.argv.slice(2));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      const err: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      process.stdout.write(JSON.stringify(err) + '\n');
      continue;
    }
    const reply = await forward(cfg, msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  }
}

main().catch((e) => {
  process.stderr.write(`genieos-mcp fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});

# @genie-os/mcp

Stdio launcher for the [GenieOS](https://genieos.pro) MCP server.

The hosted MCP server lives at `https://mcp.genieos.pro/v1` and speaks the
Streamable HTTP transport. This package is a tiny stdio bridge for editors
(Claude Desktop, older Cursor builds, etc.) that only speak the stdio MCP
transport.

> **The easiest path is OAuth, not this package.** Recent editors
> (Cursor, Claude, VS Code, Codex) discover GenieOS's OAuth metadata at
> `https://mcp.genieos.pro/v1` and authenticate you with a browser
> consent screen — no token, no config file. Point your editor at the
> URL directly and click **Allow**. Use this stdio bridge only for
> editors that can't speak HTTP MCP, or for headless / CI setups.

## Install for Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "genieos": {
      "command": "npx",
      "args": ["-y", "@genie-os/mcp@latest"],
      "env": { "GENIEOS_API_KEY": "gos_live_..." }
    }
  }
}
```

## Install for Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "genieos": {
      "command": "npx",
      "args": ["-y", "@genie-os/mcp@latest"],
      "env": { "GENIEOS_API_KEY": "gos_live_..." }
    }
  }
}
```

## Generating an API key

In the GenieOS app, go to **Settings → Developers → API keys**, create a
key with the scopes you want the agent to have, and copy the secret.

## Connecting directly via HTTP

If your editor supports the Streamable HTTP MCP transport (recent Cursor
builds, Claude Code, Continue, etc.), skip this package and point the
editor at `https://mcp.genieos.pro/v1` directly — it will run the OAuth
consent flow for you:

```bash
claude mcp add --transport http genieos https://mcp.genieos.pro/v1
```

## Configuration reference

| Source                                    | Field   | Notes                            |
| ----------------------------------------- | ------- | -------------------------------- |
| `GENIEOS_API_KEY` env var                 | API key | Recommended for editors          |
| `GENIEOS_MCP_URL` env var                 | URL     | Override the MCP endpoint        |
| `--api-key=...` flag                      | API key | Local debugging                  |
| `--url=...` flag                          | URL     | Local debugging                  |
| `~/.genieos/credentials.json` `apiKey`    | API key | Shared with the `genie` CLI      |
| `~/.genieos/credentials.json` `mcpUrl`    | URL     | Shared with the `genie` CLI      |

## License

MIT

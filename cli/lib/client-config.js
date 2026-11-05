"use strict";
// Renders per-client MCP connection settings as text. Pure: no file, network or environment
// access, so nothing here can write a client config. A caller prints the text; the person
// applies it. Test-enforced by cli/test/client-config.mjs.

const CLIENTS = ["cursor", "codex", "chatgpt"];

function checkUrl(mcpUrl) {
  const u = new URL(mcpUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
    throw new Error("MCP connector URL must be HTTPS without credentials, query or fragment");
  }
  return u.href;
}

function render(client, mcpUrl) {
  const url = checkUrl(mcpUrl);
  if (client === "cursor") {
    return { client, kind: "file", targets: ["~/.cursor/mcp.json", ".cursor/mcp.json"],
             text: `${JSON.stringify({ mcpServers: { quadron: { url } } }, null, 2)}\n` };
  }
  if (client === "codex") {
    return { client, kind: "file", targets: ["~/.codex/config.toml", ".codex/config.toml"],
             text: `[mcp_servers.quadron]\nurl = ${JSON.stringify(url)}\n` };
  }
  if (client === "chatgpt") return { client, kind: "url", targets: [], text: `${url}\n` };
  throw new Error(`unknown client: ${client}`);
}

module.exports = { CLIENTS, render };

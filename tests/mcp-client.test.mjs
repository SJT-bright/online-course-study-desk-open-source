/**
 * MCP 客户端单测：不依赖外部包。
 * 用一个内嵌的「迷你 MCP stdio 服务」验证 initialize / tools/list / tools/call 全链路。
 * 运行：node tests/mcp-client.test.mjs
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClient, McpStdioTransport, McpHttpTransport, splitCommandLine } from "../lib/mcp-client.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.error("  ✗ " + label); }
}

/* 迷你 MCP 服务：按换行分隔 JSON-RPC 应答 */
const serverScript = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" },
    }}) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "echo", description: "原样返回", inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }]}}) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
      content: [{ type: "text", text: "echo:" + (msg.params.arguments?.text ?? "") }], isError: false,
    }}) + "\\n");
  }
});
`;

const tmp = mkdtempSync(path.join(tmpdir(), "mcp-test-"));
const serverFile = path.join(tmp, "mini-mcp.cjs");
writeFileSync(serverFile, serverScript);

console.log("splitCommandLine:");
{
  const parts = splitCommandLine('npx -y @modelcontextprotocol/server-filesystem "~/My Docs"');
  ok(parts.length === 4 && parts[3] === "~/My Docs", "引号路径拆分正确");
  ok(splitCommandLine("  uvx   mcp-server-fetch ").join("|") === "uvx|mcp-server-fetch", "多余空格忽略");
  ok(splitCommandLine("").length === 0, "空命令返回空数组");
}

console.log("stdio 全链路:");
{
  const transport = new McpStdioTransport({ command: process.execPath, args: [serverFile] });
  const client = new McpClient(transport);
  await transport.start();
  const init = await client.initialize();
  ok(init?.serverInfo?.name === "mini", "initialize 握手成功");
  const tools = await client.listTools();
  ok(tools?.tools?.[0]?.name === "echo", "tools/list 返回工具");
  const called = await client.callTool("echo", { text: "你好" });
  ok(called?.content?.[0]?.text === "echo:你好", "tools/call 结果正确");
  client.close();
}

console.log("stdio 错误处理:");
{
  const transport = new McpStdioTransport({ command: process.execPath, args: ["-e", "process.exit(3)"] });
  const client = new McpClient(transport);
  let err = null;
  try { await transport.start(); await client.initialize(); } catch (e) { err = e; }
  ok(!!err, "进程立即退出时报错而不挂起");
  client.close();
}

console.log("http 传输（指向不存在端口，应快速失败）:");
{
  const transport = new McpHttpTransport({ url: "http://127.0.0.1:9/mcp" });
  const client = new McpClient(transport);
  let err = null;
  try { await transport.start(); await client.initialize(); } catch (e) { err = e; }
  ok(!!err, "连接失败抛出错误");
  client.close();
}

console.log(`\\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);

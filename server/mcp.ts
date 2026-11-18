import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runTool, tools } from "./tools";

// Exposes the weather tools over MCP (stdio) so any MCP client (Claude Desktop, Claude Code, etc.) can use them.
// Reuses the same tool definitions as the web agent, so the two never drift apart.
// stdout carries the MCP protocol: log to stderr only.
const server = new Server({ name: "weather", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
        const text = await runTool(req.params.name, req.params.arguments);
        return { content: [{ type: "text", text }] };
    } catch (err) {
        // Report failures as tool errors so the client's model can recover, same as the web agent does.
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: message }], isError: true };
    }
});

async function main() {
    await server.connect(new StdioServerTransport());
    console.error("Weather MCP server running on stdio");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

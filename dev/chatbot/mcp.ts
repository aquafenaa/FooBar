import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Snowflake } from 'discord.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResult, McpError, Tool } from '@modelcontextprotocol/sdk/types.js';
import { deleteMcpServer, getChatbot, getMcpServer, getMcpServersByServer, insertMcpServer, updateMcpServer, upsertChatbot } from '../data';
import { McpServerTable } from '../types/schema';

const MAX_MCP_SERVERS = 10; // per server, since /chatbot tools lists them in one checkbox group, which holds at most 10
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/; // it starts each tool's name, which openrouter limits to these characters
const CONNECT_TIMEOUT = 10_000; // a server that's down holds up every reply until this runs out, so it's kept short
const CALL_TIMEOUT = 120_000;
const TOOLS_TTL = 5 * 60_000; // how long a server's tool list is reused before it's asked again
const RETRY_AFTER = 2 * 60_000; // a server that couldn't be reached is left out of replies for this long, rather than tried each time
const MAX_RESULT_LENGTH = 20_000;

type Connection = { client: Client, tools: Tool[], listedAt: number };
// one per MCP server, shared by every reply. a promise, so replies starting at once share one connection attempt
const connections = new Map<string, Promise<Connection>>();
const failedAt = new Map<string, number>();
const connectionKey = (mcp: McpServerTable) => `${mcp.server_id}|${mcp.mcp_name.toLowerCase()}`;

// what /chatbot tools turns a server on and off by, in disabled_tools beside the built-in groups
function mcpGroupKey(name: string): string {
  return `mcp:${name.toLowerCase()}`;
}

// loopback, private, link-local, and carrier-grade NAT ranges, so a server's admin can't point the bot at its own host's services
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === '::' || lower === '::1' || /^(fc|fd|fe[89ab])/.test(lower);
  }
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// what's wrong with a URL, if anything. private addresses are only allowed from a DM with the bot's owner
async function urlProblem(raw: string, allowPrivate: boolean): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That isn\'t a valid URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'MCP server URLs have to start with https:// or http://.';
  if (allowPrivate) return undefined;

  const host = url.hostname.replace(/^\[|\]$/g, ''); // an IPv6 address comes in brackets
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((results) => results.map((result) => result.address)).catch(() => undefined);
  if (!addresses) return `Couldn't find ${host}.`;
  if (addresses.some(isPrivateAddress)) return 'That URL points at a private or local address, which can only be added from a DM with the bot\'s owner.';
  return undefined;
}

// sent as the Authorization header. a bare token is taken as a bearer token, and one with a scheme ("Basic ...") is sent as it is
function authHeaders(mcp: McpServerTable): Record<string, string> | undefined {
  if (!mcp.auth_token) return undefined;
  return { Authorization: mcp.auth_token.includes(' ') ? mcp.auth_token : `Bearer ${mcp.auth_token}` };
}

// every tool it has, a page at a time
async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor && tools.length < 500);
  return tools;
}

async function connect(mcp: McpServerTable): Promise<Connection> {
  const url = new URL(mcp.url);
  const requestInit = { headers: authHeaders(mcp) };
  let client = new Client({ name: 'foobar', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }), { timeout: CONNECT_TIMEOUT });
  } catch (error) {
    // older servers only speak SSE. a fresh client, since the failed one is left half set up
    client.close().catch(() => {});
    client = new Client({ name: 'foobar', version: '1.0.0' });
    await client.connect(new SSEClientTransport(url, { requestInit }), { timeout: CONNECT_TIMEOUT }).catch(() => { throw error; }); // the first error says more
  }

  const key = connectionKey(mcp);
  client.onclose = () => connections.delete(key);
  try {
    return { client, tools: await listAllTools(client), listedAt: Date.now() };
  } catch (error) {
    client.close().catch(() => {});
    throw error;
  }
}

function getConnection(mcp: McpServerTable): Promise<Connection> {
  const key = connectionKey(mcp);
  let connection = connections.get(key);
  if (!connection) {
    connection = connect(mcp);
    connections.set(key, connection);
    const attempt = connection;
    attempt.then(() => failedAt.delete(key), () => {
      if (connections.get(key) === attempt) connections.delete(key);
      failedAt.set(key, Date.now());
    });
  }
  return connection;
}

// after it's edited or deleted, or once its session seems to have died. the next use connects again
function closeMcpConnection(mcp: McpServerTable): void {
  const key = connectionKey(mcp);
  const connection = connections.get(key);
  connections.delete(key);
  failedAt.delete(key);
  connection?.then(({ client }) => client.close()).catch(() => {});
}

// its tools, asked again once the list is old. undefined if it can't be reached, or couldn't be recently
async function getTools(mcp: McpServerTable): Promise<Tool[] | undefined> {
  if (Date.now() - (failedAt.get(connectionKey(mcp)) ?? 0) < RETRY_AFTER) return undefined;
  try {
    const connection = await getConnection(mcp);
    if (Date.now() - connection.listedAt > TOOLS_TTL) {
      connection.tools = await listAllTools(connection.client);
      connection.listedAt = Date.now();
    }
    return connection.tools;
  } catch (error: any) {
    console.error(`MCP server ${mcp.mcp_name} (${mcp.url}) couldn't be reached: ${error?.message ?? error}`);
    closeMcpConnection(mcp);
    failedAt.set(connectionKey(mcp), Date.now());
    return undefined;
  }
}

/**
 * Checks a server can be connected to, then adds or updates it. Its tools' names on success, or what went wrong.
 * existing is the row being edited: its URL isn't checked again if it's unchanged, since it may have been added from a DM
 */
async function saveMcpServer(mcp: McpServerTable, { existing, allowPrivate }: { existing?: McpServerTable, allowPrivate: boolean }): Promise<{ tools: string[] } | { error: string }> {
  if (!MCP_NAME_PATTERN.test(mcp.mcp_name)) return { error: 'Names can only use letters, numbers, - and _, and be at most 32 characters, since each of its tools\' names starts with it.' };
  if (!mcp.description.trim()) return { error: 'A description is needed, so the chatbot knows what the server is for.' };
  const duplicateProblem = () => {
    if (existing) return undefined;
    const duplicate = getMcpServer(mcp.server_id, mcp.mcp_name);
    if (duplicate) return `There's already an MCP server named "${duplicate.mcp_name}".`;
    if (getMcpServersByServer(mcp.server_id).length >= MAX_MCP_SERVERS) return `A server can have at most ${MAX_MCP_SERVERS} MCP servers. Delete one first.`;
    return undefined;
  };
  const before = duplicateProblem();
  if (before) return { error: before };
  if (mcp.url !== existing?.url) {
    const problem = await urlProblem(mcp.url, allowPrivate);
    if (problem) return { error: problem };
  }

  closeMcpConnection(mcp); // its URL or token may have changed
  let tools: Tool[];
  try {
    ({ tools } = await getConnection(mcp));
  } catch (error: any) {
    closeMcpConnection(mcp);
    return { error: `Couldn't connect to ${mcp.url}: ${error?.message ?? error}` };
  }

  const after = duplicateProblem(); // in case another was added while it connected
  if (after) {
    closeMcpConnection(mcp);
    return { error: after };
  }
  if (existing) updateMcpServer(mcp);
  else insertMcpServer(mcp);
  return { tools: tools.map((t) => t.name) };
}

// deletes it, closes its connection, and forgets whether /chatbot tools had it off, so one added later by the same name starts on
function removeMcpServer(mcp: McpServerTable): void {
  deleteMcpServer(mcp.server_id, mcp.mcp_name);
  closeMcpConnection(mcp);

  const chatbot = getChatbot(mcp.server_id);
  const key = mcpGroupKey(mcp.mcp_name);
  if (chatbot?.disabled_tools?.includes(key)) {
    chatbot.disabled_tools = chatbot.disabled_tools.filter((disabled) => disabled !== key);
    upsertChatbot(chatbot);
  }
}

// one of an MCP server's tools, as offered to the model
type McpOffer = { mcp: McpServerTable, tool: Tool, description: string, parameters: Record<string, unknown> };

/**
 * The tools of every MCP server in a server that's on, by the name the model sees: <server>__<tool>.
 * Servers are asked at once, and any that can't be reached are left out of this reply
 */
async function getMcpOffers(serverID: Snowflake, disabledGroups?: string[]): Promise<Map<string, McpOffer>> {
  const servers = getMcpServersByServer(serverID).filter((mcp) => !disabledGroups?.includes(mcpGroupKey(mcp.mcp_name)));
  const listed = await Promise.all(servers.map(async (mcp) => ({ mcp, tools: await getTools(mcp) ?? [] })));

  const offers = new Map<string, McpOffer>();
  listed.forEach(({ mcp, tools }) => tools.forEach((tool) => {
    const name = `${mcp.mcp_name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
    if (offers.has(name)) return; // two tools only told apart past the length limit. the first is kept
    offers.set(name, {
      mcp,
      tool,
      description: `From the "${mcp.mcp_name}" MCP server: ${mcp.description}\n\n${tool.description ?? tool.title ?? ''}`.trim(),
      parameters: tool.inputSchema,
    });
  }));
  return offers;
}

/**
 * Runs one of an MCP server's tools. Its text comes back as content, and its first image as image, which chatbot.ts gives the model as one.
 * A call that fails before reaching the server (e.g. its session expired) is tried once more on a fresh connection.
 * One the server answered with an error, or that timed out, isn't, since it may have already done something
 */
async function callMcpTool(offer: McpOffer, input: unknown, { images, signal }: { images: boolean, signal?: AbortSignal }): Promise<{ result: 'success' | 'failure', content?: string, image?: string, message?: string }> {
  const { mcp, tool } = offer;
  const call = async () => (await getConnection(mcp)).client.callTool(
    { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
    undefined,
    { timeout: CALL_TIMEOUT, signal },
  ) as Promise<CallToolResult>;

  let response: CallToolResult;
  try {
    try {
      response = await call();
    } catch (error) {
      if (error instanceof McpError || signal?.aborted) throw error;
      closeMcpConnection(mcp);
      response = await call();
    }
  } catch (error: any) {
    return { result: 'failure', message: `The ${mcp.mcp_name} MCP server failed: ${error?.message ?? error}` };
  }

  const texts: string[] = [];
  let image: string | undefined;
  (response.content ?? []).forEach((part) => {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') {
      if (images && !image) image = `data:${part.mimeType};base64,${part.data}`;
      else texts.push(images ? '[another image, left out]' : '[an image, which this model can\'t see]');
    } else if (part.type === 'resource') texts.push('text' in part.resource ? part.resource.text : `[a file at ${part.resource.uri}]`);
    else if (part.type === 'resource_link') texts.push(`[${part.name}](${part.uri})`);
    else if (part.type === 'audio') texts.push('[audio, which you can\'t hear]');
  });
  let content = texts.join('\n') || (response.structuredContent ? JSON.stringify(response.structuredContent) : '');
  if (content.length > MAX_RESULT_LENGTH) content = `${content.substring(0, MAX_RESULT_LENGTH)}\n[cut off, ${(content.length - MAX_RESULT_LENGTH).toLocaleString()} more characters]`;

  return { result: response.isError ? 'failure' : 'success', content, image };
}

// for /mcp view: the names of its tools, or why they couldn't be listed
async function listMcpToolNames(mcp: McpServerTable): Promise<string[] | string> {
  try {
    return (await getConnection(mcp)).tools.map((t) => t.name);
  } catch (error: any) {
    return `Couldn't connect: ${error?.message ?? error}`;
  }
}

export { McpOffer, MAX_MCP_SERVERS, mcpGroupKey, saveMcpServer, removeMcpServer, getMcpOffers, callMcpTool, listMcpToolNames };

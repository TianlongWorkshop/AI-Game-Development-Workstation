'use strict';
// 测试用的 MCP Streamable HTTP 服务端，按 MCP 规范实现：
// initialize 返回 Mcp-Session-Id；之后的请求必须带该会话头；支持 JSON 与 SSE 两种响应方式；工具列表分页。
const http = require('node:http');
const crypto = require('node:crypto');

function startMockMcp({mode = 'json', token = null, pageSize = 2, unrealStyle = false} = {}) {
  const sessions = new Set();
  const calls = [];
  const tools = unrealStyle ? [
    {name: 'list_toolsets', description: 'List toolsets', inputSchema: {type: 'object', properties: {}}},
    {name: 'describe_toolsets', description: 'Describe toolsets', inputSchema: {type: 'object', properties: {toolsets: {type: 'array', items: {type: 'string'}}}}},
    {name: 'describe_tools', description: 'Describe tools', inputSchema: {type: 'object', properties: {tools: {type: 'array', items: {type: 'string'}}}}},
    {name: 'call_tool', description: 'Call tool', inputSchema: {type: 'object', properties: {tool: {type: 'string'}, arguments: {type: 'object'}}, required: ['tool']}}
  ] : [
    {name: 'get_scene_info', description: 'Read scene', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}},
    {name: 'create_object', description: 'Create object', inputSchema: {type: 'object', properties: {type: {type: 'string'}}, required: ['type']}},
    {name: 'capture_viewport', description: 'Screenshot', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}},
    {name: 'delete_objects', description: 'Delete', inputSchema: {type: 'object', properties: {names: {type: 'array', items: {type: 'string'}}}}, annotations: {destructiveHint: true}},
    {name: 'run_python', description: 'Run python', inputSchema: {type: 'object', properties: {code: {type: 'string'}}}}
  ];
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

  function handle(msg) {
    const {id, method, params = {}} = msg;
    if (method === 'initialize') return {jsonrpc: '2.0', id, result: {protocolVersion: params.protocolVersion === '2025-06-18' ? '2025-06-18' : '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: unrealStyle ? 'unreal-mcp-mock' : 'mock', version: '9.9'}, instructions: 'mock instructions'}};
    if (method === 'ping') return {jsonrpc: '2.0', id, result: {}};
    if (method === 'tools/list') {
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = tools.slice(start, start + pageSize);
      const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
      return {jsonrpc: '2.0', id, result: {tools: page, ...(next ? {nextCursor: next} : {})}};
    }
    if (method === 'tools/call') {
      calls.push(params);
      const n = params.name;
      if (n === 'capture_viewport') return {jsonrpc: '2.0', id, result: {content: [{type: 'image', data: PNG, mimeType: 'image/png'}, {type: 'text', text: 'shot'}]}};
      if (n === 'get_scene_info') return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: JSON.stringify({objects: [{name: 'Cube'}]})}]}};
      if (n === 'slow') return new Promise(r => setTimeout(() => r({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: 'late'}]}}), 2000));
      if (n === 'fail') return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: 'boom'}], isError: true}};
      if (!tools.some(t => t.name === n)) return {jsonrpc: '2.0', id, error: {code: -32602, message: 'Unknown tool ' + n}};
      return {jsonrpc: '2.0', id, result: {content: [{type: 'text', text: `${n} ok ${JSON.stringify(params.arguments)}`}]}};
    }
    return {jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}};
  }

  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (token && req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401, {'content-type': 'application/json'}).end(JSON.stringify({error: {message: 'unauthorized'}})); return; }
    if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const accept = String(req.headers.accept || '');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) { res.writeHead(406).end(); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (msg.method !== 'initialize') {
        const sid = req.headers['mcp-session-id'];
        if (!sessions.has(sid)) { res.writeHead(404, {'content-type': 'application/json'}).end(JSON.stringify({jsonrpc: '2.0', id: msg.id ?? null, error: {code: -32001, message: 'Session not found'}})); return; }
        if (!req.headers['mcp-protocol-version']) { res.writeHead(400).end('missing protocol version'); return; }
      }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = await handle(msg);
      const headers = {};
      if (msg.method === 'initialize') { const sid = crypto.randomUUID(); sessions.add(sid); headers['mcp-session-id'] = sid; }
      if (mode === 'sse') {
        res.writeHead(200, {...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
        res.write(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', method: 'notifications/progress', params: {progress: 1}})}\n\n`);
        const text = JSON.stringify(reply);
        res.write('event: message\ndata: ' + text.slice(0, 10));
        setTimeout(() => { res.write(text.slice(10) + '\n\n'); res.end(); }, 20);
      } else {
        res.writeHead(200, {...headers, 'content-type': 'application/json'});
        res.end(JSON.stringify(reply));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({url: `http://127.0.0.1:${port}/mcp`, port, calls, sessions, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); })});
  }));
}

module.exports = {startMockMcp};

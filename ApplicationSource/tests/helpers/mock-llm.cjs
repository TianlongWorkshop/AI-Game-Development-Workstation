'use strict';
// 本机模拟的 OpenAI 兼容模型服务：支持能力探测，以及按用户指令脚本化地发起工具调用。
const http = require('node:http');

function startMockLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      requests.push({url: req.url, auth: req.headers.authorization, body: j});
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const lastText = typeof last.content === 'string' ? last.content : (last.content || []).map(p => p.text || '').join('');
      const tools = (j.tools || []).map(t => t.function.name);
      const find = suffix => tools.find(n => n.endsWith(suffix));
      let message;
      if (tools.includes('get_number')) message = {content: null, tool_calls: [{id: 'p1', type: 'function', function: {name: 'get_number', arguments: '{}'}}]};
      else if (lastText.includes('只回复两个字母')) message = {content: 'OK'};
      else if (lastText.includes('什么颜色')) message = {content: '红色'};
      else if (last.role === 'tool' || lastText.startsWith('以下是上面工具调用返回的图像')) message = {content: '完成：已按你的要求操作，并截图确认。'};
      else if (lastText.includes('跑脚本') && find('__run_python')) message = {content: '我将执行一段脚本。', tool_calls: [{id: 's1', type: 'function', function: {name: find('__run_python'), arguments: JSON.stringify({code: 'print(1)'})}}]};
      else if (lastText.includes('方块') && find('__echo')) message = {content: '先读取场景，再截图。', tool_calls: [{id: 't1', type: 'function', function: {name: find('__echo'), arguments: '{"what":"scene"}'}}, {id: 't2', type: 'function', function: {name: find('__image'), arguments: '{}'}}]};
      else message = {content: '你好，我是测试模型。'};
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({choices: [{message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 20}}));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(x => { server.closeAllConnections?.(); server.close(() => x()); })})));
}

module.exports = {startMockLLM};

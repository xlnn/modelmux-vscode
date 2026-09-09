'use strict';
const http = require('http');
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    try {
      const value = JSON.parse(body);
      const summary = {
        keys: Object.keys(value), model: value.model,
        instructionsType: typeof value.instructions,
        inputType: Array.isArray(value.input) ? 'array' : typeof value.input,
        inputCount: Array.isArray(value.input) ? value.input.length : null,
        inputSamples: Array.isArray(value.input) ? value.input.slice(0, 10).map(item => ({
          type: item && item.type, role: item && item.role, keys: item && Object.keys(item),
          contentTypes: Array.isArray(item && item.content) ? item.content.map(part => part && part.type) : undefined
        })) : [],
        toolTypes: Array.isArray(value.tools) ? value.tools.map(tool => ({ type: tool && tool.type, keys: tool && Object.keys(tool), name: tool && tool.name })) : [],
        reasoning: value.reasoning, text: value.text, stream: value.stream, include: value.include
      };
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } catch (error) { process.stdout.write(`PARSEERR ${error.message}\n`); }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","status":"in_progress","model":"claude-test","output":[]}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","status":"completed","model":"claude-test","output":[]}}\n\n');
    setTimeout(() => server.close(), 50);
  });
});
server.listen(1234, '127.0.0.1', () => process.stdout.write('READY\n'));

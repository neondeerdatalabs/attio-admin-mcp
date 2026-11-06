// Smoke test: does the server speak MCP? No credentials needed.
const { spawn } = require('child_process');

const child = spawn('node', [__dirname + '/server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

let out = '';
child.stdout.on('data', (c) => (out += c));

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
child.stdin.end();

child.on('close', () => {
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.result && j.result.serverInfo) {
      console.log('initialize OK ->', j.result.serverInfo.name, j.result.serverInfo.version);
    }
    if (j.result && j.result.tools) {
      console.log('tools/list OK ->', j.result.tools.length, 'tools');
      for (const t of j.result.tools) console.log('  -', t.name);
    }
    if (j.error) console.log('ERROR:', j.error.message);
  }
});

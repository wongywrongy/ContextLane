import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') res.end(JSON.stringify({ service: 'rootlane-disposable-api', ready: true }));
  else if (req.url === '/api/redirect') { res.statusCode = 302; res.setHeader('location', '/api/message'); res.end(); }
  else if (req.url === '/api/message') res.end(JSON.stringify({ message: 'The disposable API is reachable.' }));
  else { res.statusCode = 404; res.end(JSON.stringify({ error: 'Not found' })); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(19481, '127.0.0.1', () => console.info('rootlane-disposable-api ready on 127.0.0.1:19481'));

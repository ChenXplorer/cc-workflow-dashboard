const net = require('net');

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findOpenPort(host, startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(host, port)) return port;
  }
  throw new Error(`No open port found from ${startPort} to ${startPort + 99}`);
}

module.exports = { findOpenPort };

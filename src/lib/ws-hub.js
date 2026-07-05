const WebSocket = require('ws');

class WsHub {
  constructor(server, options = {}) {
    this.path = options.path || '/ws';
    this.wss = new WebSocket.Server({ server, path: this.path });
    this.wss.on('connection', (socket) => {
      socket.send(JSON.stringify({
        type: 'hello',
        at: new Date().toISOString()
      }));
    });
  }

  broadcast(type, payload = {}) {
    const message = JSON.stringify({
      type,
      payload,
      at: new Date().toISOString()
    });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  close() {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

module.exports = { WsHub };

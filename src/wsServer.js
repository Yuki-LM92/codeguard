'use strict';

const { WebSocketServer } = require('ws');

let wss = null;
const clients = new Set();

function createWsServer(config) {
  wss = new WebSocketServer({ host: '127.0.0.1', port: config.wsPort });

  wss.on('connection', (ws, req) => {
    // localhost以外からの接続を拒否
    const origin = req.headers.origin || '';
    const isLocalOrigin = !origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    if (!isLocalOrigin) {
      ws.close(1008, 'Forbidden');
      return;
    }

    clients.add(ws);
    // クライアントからのメッセージは受け付けない（一方向ブロードキャストのみ）
    ws.on('message', () => ws.close(1008, 'Not supported'));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return wss;
}

/**
 * 全クライアントに承認リクエストをブロードキャスト
 * @param {Object} payload - riskAnalyzer の出力
 */
function broadcast(payload) {
  const message = JSON.stringify({ type: 'approval', payload });
  for (const client of clients) {
    try {
      if (client.readyState === 1 /* OPEN */) {
        client.send(message);
      }
    } catch (e) {
      clients.delete(client);
    }
  }
}

module.exports = { createWsServer, broadcast };

'use strict';

const express = require('express');
const path = require('path');
const { parseCommand } = require('./commandParser');
const { analyze } = require('./riskAnalyzer');

// コマンド入力の最大長（DoS対策）
const MAX_COMMAND_LENGTH = 2048;

// シンプルなレート制限（1IPあたり60秒で100リクエスト）
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  const window = 60_000;
  const maxReq = 100;

  const record = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - record.start > window) {
    record.count = 0;
    record.start = now;
  }
  record.count++;
  rateLimitMap.set(ip, record);

  if (record.count > maxReq) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

function createHttpServer(config) {
  const app = express();

  // セキュリティヘッダー
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*");
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // レート制限（APIのみ）
  app.use('/api/', rateLimit);

  // UI配信
  app.use(express.static(path.join(__dirname, '..', 'ui')));

  // WebSocketポートをUIに埋め込む（JSON.stringifyで安全にシリアライズ）
  app.get('/', (req, res) => {
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    const configScript = `<script>window.CODEGUARD_CONFIG = ${JSON.stringify({ wsPort: config.wsPort })};</script>`;
    html = html.replace('</head>', `${configScript}\n</head>`);
    res.send(html);
  });

  // コマンド解析API（手動入力用）
  app.get('/api/analyze', (req, res) => {
    const cmd = String(req.query.command || '').slice(0, MAX_COMMAND_LENGTH);
    try {
      const parsed = parseCommand(cmd);
      const result = analyze(parsed);
      res.json(result);
    } catch (e) {
      // 内部エラーの詳細は返さない
      res.status(500).json({ error: '解析中にエラーが発生しました' });
    }
  });

  // ヘルスチェック
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: require('../package.json').version });
  });

  const server = app.listen(config.port, '127.0.0.1', () => {});
  return server;
}

module.exports = { createHttpServer };

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { createHttpServer } = require('./httpServer');
const { createWsServer } = require('./wsServer');
const { startWatcher } = require('./logWatcher');

const DEFAULT_CONFIG = {
  port: 19280,
  wsPort: 19281,
  claudeProjectsPath: '~/.claude/projects',
  language: 'ja',
  displayMode: 'notification',
  soundEnabled: true,
  soundOnlyLevel: 'critical',
  theme: 'auto',
  maxHistory: 100
};

function loadConfig(configPath) {
  const resolved = configPath || path.join(os.homedir(), '.codeguard', 'config.json');

  if (!fs.existsSync(resolved)) {
    // 初回起動：設定ファイルを生成
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return { ...DEFAULT_CONFIG };
  }

  try {
    const loaded = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return { ...DEFAULT_CONFIG, ...loaded };
  } catch (e) {
    console.warn('[CodeGuard] 設定ファイルの読み込みに失敗しました。デフォルト設定を使用します。');
    return { ...DEFAULT_CONFIG };
  }
}

async function start(options = {}) {
  const config = loadConfig(options.config);
  if (options.port) config.port = parseInt(options.port, 10);

  console.log('');
  console.log('🛡️  CodeGuard v' + require('../package.json').version);
  console.log(`   UI:  http://localhost:${config.port}`);
  console.log(`   監視: ${config.claudeProjectsPath}`);
  console.log('   Ctrl+C で終了');
  console.log('');

  // WebSocketサーバー起動
  createWsServer(config);

  // HTTPサーバー起動
  createHttpServer(config);

  // ログ監視起動
  startWatcher(config.claudeProjectsPath);

  // ブラウザを開く
  if (options.open !== false) {
    const url = `http://localhost:${config.port}`;
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd);
  }

  // 終了ハンドラ
  process.on('SIGINT', () => {
    console.log('\n[CodeGuard] 終了します。');
    process.exit(0);
  });
}

module.exports = { start, loadConfig };

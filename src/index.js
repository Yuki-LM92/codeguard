'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { createHttpServer } = require('./httpServer');
const { createWsServer, broadcastSystem } = require('./wsServer');
const { startWatcher, inspectWatchPath } = require('./logWatcher');
const { checkForUpdates } = require('./updateChecker');

const DEFAULT_CONFIG = {
  port: 19280,
  wsPort: 19281,
  claudeProjectsPath: '~/.claude/projects',
  language: 'ja',
  displayMode: 'notification',
  soundEnabled: true,
  soundOnlyLevel: 'critical',
  theme: 'auto',
  maxHistory: 100,
  // 社内配布時など、GitHubへの更新確認を止めたい場合は false にする
  checkForUpdates: true
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
  if (options.checkForUpdates === false) config.checkForUpdates = false;

  // 監視先の状態を先に調べ、初回利用者に何が起きるか伝える
  const watchState = inspectWatchPath(config.claudeProjectsPath);

  console.log('');
  console.log('🛡️  CodeGuard v' + require('../package.json').version);
  console.log(`   UI:  http://localhost:${config.port}`);
  console.log(`   監視: ${config.claudeProjectsPath}`);
  console.log('   Ctrl+C で終了');
  console.log('');

  if (!watchState.hasLogs) {
    console.log('   ────────────────────────────────────────────');
    console.log('   まだClaude Codeの記録が見つかりません。');
    console.log('');
    console.log('   この画面を開いたまま、別のターミナルで');
    console.log('   Claude Code を使ってみてください。');
    console.log('   実行された操作がブラウザに表示されます。');
    console.log('   ────────────────────────────────────────────');
    console.log('');
  }

  // WebSocketサーバー起動
  createWsServer(config);

  // HTTPサーバー起動
  createHttpServer(config);

  // ログ監視起動
  startWatcher(config.claudeProjectsPath);

  // 初回利用者向けの案内をUIにも送る（WS接続の確立を待つ）
  if (!watchState.hasLogs) {
    setTimeout(() => {
      broadcastSystem('waiting', {
        title: 'Claude Codeの操作を待っています',
        message: 'このタブを開いたまま、Claude Codeを使ってみてください。実行された操作がここに表示されます。'
      });
    }, 1000);
  }

  // アップデートチェック（起動の邪魔をしないよう3秒後に非同期で実行）
  if (config.checkForUpdates !== false) {
    const currentVersion = require('../package.json').version;
    setTimeout(() => checkForUpdates(currentVersion, broadcastSystem), 3000);
  }

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

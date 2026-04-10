#!/usr/bin/env node
'use strict';

const { start } = require('../src/index');

const args = process.argv.slice(2);
const options = {};

// --version
if (args.includes('--version') || args.includes('-v')) {
  console.log('CodeGuard v' + require('../package.json').version);
  process.exit(0);
}

// --help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🛡️  CodeGuard - Claude Code 承認アシスタント

使い方:
  codeguard [オプション]

オプション:
  --port <番号>      HTTPポート番号 (デフォルト: 19280)
  --no-open          ブラウザを自動で開かない
  --config <パス>    設定ファイルのパスを指定
  --version, -v      バージョンを表示
  --help, -h         このヘルプを表示
`);
  process.exit(0);
}

// --port
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  options.port = args[portIdx + 1];
}

// --no-open
if (args.includes('--no-open')) {
  options.open = false;
}

// --config
const configIdx = args.indexOf('--config');
if (configIdx !== -1 && args[configIdx + 1]) {
  options.config = args[configIdx + 1];
}

start(options).catch(err => {
  console.error('[CodeGuard] 起動エラー:', err.message);
  process.exit(1);
});

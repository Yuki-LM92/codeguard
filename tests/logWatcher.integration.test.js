'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// broadcast をモックに差し替えてから logWatcher を読み込む
const wsServer = require('../src/wsServer');
const received = [];
wsServer.broadcast = (payload) => received.push(payload);

// require キャッシュの都合上、モック設定後に読み込む必要がある
delete require.cache[require.resolve('../src/logWatcher')];
const { startWatcher, inspectWatchPath } = require('../src/logWatcher');

const LINE_DANGER = JSON.stringify({
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }]
  }
});

const LINE_SAFE = JSON.stringify({
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]
  }
});

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeguard-test-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('存在しない監視ディレクトリは自動作成される', async () => {
  const base = mkTmpDir();
  const target = path.join(base, 'not-yet', 'projects');
  assert.ok(!fs.existsSync(target), '前提：まだ存在しない');

  const watcher = startWatcher(target);
  try {
    assert.ok(fs.existsSync(target), '監視開始時に作成されること');
  } finally {
    // 失敗時も必ず閉じる（開いたままだとテストランナーが終了しない）
    await watcher.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('inspectWatchPath はログの有無を判定できる', () => {
  const base = mkTmpDir();
  const projects = path.join(base, 'projects', 'session');
  fs.mkdirSync(projects, { recursive: true });

  let state = inspectWatchPath(path.join(base, 'projects'));
  assert.equal(state.exists, true);
  assert.equal(state.hasLogs, false, 'jsonl が無ければ false');

  fs.writeFileSync(path.join(projects, 's.jsonl'), LINE_SAFE + '\n');
  state = inspectWatchPath(path.join(base, 'projects'));
  assert.equal(state.hasLogs, true, 'jsonl があれば true');

  fs.rmSync(base, { recursive: true, force: true });
});

// 回帰テスト：add イベントで内容を読まないと、セッション最初の操作を取りこぼす。
// Claude Code はセッション開始時に新しい .jsonl を作るため、実運用で必ず踏む。
test('新規作成された jsonl の内容が検出される（回帰）', async () => {
  const base = mkTmpDir();
  const projects = path.join(base, 'projects');
  const session = path.join(projects, 'session');
  fs.mkdirSync(session, { recursive: true });

  received.length = 0;
  const watcher = startWatcher(projects);
  try {
    await sleep(300); // 監視の確立を待つ

    // 内容を持った状態でファイルを一括作成する
    fs.writeFileSync(path.join(session, 'new.jsonl'), LINE_DANGER + '\n');
    await sleep(800);

    assert.equal(received.length, 1, '新規ファイルの1行目が検出されること');
    assert.equal(received[0].riskLevel, 'critical');
  } finally {
    await watcher.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('既存 jsonl への追記が検出される', async () => {
  const base = mkTmpDir();
  const projects = path.join(base, 'projects');
  const session = path.join(projects, 'session');
  fs.mkdirSync(session, { recursive: true });
  const logFile = path.join(session, 's.jsonl');
  fs.writeFileSync(logFile, '');

  received.length = 0;
  const watcher = startWatcher(projects);
  try {
    await sleep(300);

    fs.appendFileSync(logFile, LINE_SAFE + '\n');
    await sleep(800);

    assert.equal(received.length, 1, '追記行が検出されること');
    assert.equal(received[0].riskLevel, 'safe');
  } finally {
    await watcher.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

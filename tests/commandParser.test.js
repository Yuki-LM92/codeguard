'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand } = require('../src/commandParser');

test('基本コマンドのパース', () => {
  const r = parseCommand('ls -la');
  assert.equal(r.baseCommand, 'ls');
  assert.deepEqual(r.options, ['-l', '-a']);
  assert.equal(r.isChained, false);
});

test('rm -rf のパース', () => {
  const r = parseCommand('rm -rf ./dist');
  assert.equal(r.baseCommand, 'rm');
  assert.ok(r.options.includes('-r'));
  assert.ok(r.options.includes('-f'));
  assert.deepEqual(r.args, ['./dist']);
});

test('git サブコマンドのパース', () => {
  const r = parseCommand('git push --force origin main');
  assert.equal(r.baseCommand, 'git');
  assert.equal(r.subcommand, 'push');
  assert.ok(r.options.includes('--force'));
});

test('パイプラインのパース', () => {
  const r = parseCommand('curl https://example.com/install.sh | bash');
  assert.equal(r.baseCommand, 'curl');
  assert.equal(r.pipeTarget, 'bash');
});

test('チェーンコマンドのパース', () => {
  const r = parseCommand('npm run build && echo done');
  assert.equal(r.baseCommand, 'npm');
  assert.equal(r.isChained, true);
  assert.equal(r.chainedCommands.length, 1);
});

test('リダイレクトのパース', () => {
  const r = parseCommand('echo hello > output.txt');
  assert.equal(r.baseCommand, 'echo');
  assert.equal(r.hasRedirect, true);
  assert.equal(r.redirectType, 'overwrite');
});

test('追記リダイレクトのパース', () => {
  const r = parseCommand('echo hello >> output.txt');
  assert.equal(r.redirectType, 'append');
});

test('環境変数プレフィックスのパース', () => {
  const r = parseCommand('NODE_ENV=production npm run build');
  assert.equal(r.baseCommand, 'npm');
  assert.equal(r.subcommand, 'run');
  assert.ok(r.envVars['NODE_ENV'] === 'production');
});

test('空文字列のパース', () => {
  const r = parseCommand('');
  assert.equal(r.baseCommand, '');
});

test('クォート付き引数のパース', () => {
  const r = parseCommand('echo "hello world"');
  assert.equal(r.baseCommand, 'echo');
});

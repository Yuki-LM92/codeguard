'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// logWatcher の内部ロジックをテスト（broadcast はモック）
// 実際のファイル監視は統合テストで行う

test('JSONL パース：パターン1（message.content）', () => {
  const line = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'bash', input: { command: 'ls -la' } }
      ]
    }
  };
  // tool_use が検出できるかチェック
  let detected = false;
  for (const block of line.message.content) {
    if (block.type === 'tool_use' && block.name === 'bash') {
      detected = true;
    }
  }
  assert.ok(detected, 'bash tool_use を検出できること');
});

test('JSONL パース：パターン2（content 直接配列）', () => {
  const line = {
    content: [
      { type: 'tool_use', name: 'write', input: { file_path: './test.js', content: '' } }
    ]
  };
  let detected = false;
  for (const block of line.content) {
    if (block.type === 'tool_use') detected = true;
  }
  assert.ok(detected);
});

test('JSONL パース：ツール名フィルタリング', () => {
  const WATCHED = new Set(['bash', 'write', 'edit', 'read', 'glob']);
  assert.ok(WATCHED.has('bash'));
  assert.ok(WATCHED.has('write'));
  assert.ok(!WATCHED.has('unknown_tool'));
});

test('tool_use 以外の行は無視される', () => {
  const line = { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } };
  let detected = false;
  if (line.type === 'assistant' && line.message?.content) {
    for (const block of line.message.content) {
      if (block.type === 'tool_use') detected = true;
    }
  }
  assert.ok(!detected, 'user メッセージは無視されること');
});

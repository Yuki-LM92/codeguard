'use strict';

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCommand } = require('./commandParser');
const { analyze } = require('./riskAnalyzer');
const { broadcast } = require('./wsServer');

// ファイルごとの読み取り位置を管理
const filePositions = new Map();
// ファイルごとの未完了行バッファ（末尾改行がない途中の行を保持）
const lineBuffers = new Map();

// 監視対象ツール（大文字・小文字両対応）
const WATCHED_TOOLS = new Set(['bash', 'write', 'edit', 'read', 'glob', 'Bash', 'Write', 'Edit', 'Read', 'Glob']);

/**
 * ログ監視を開始する
 * @param {string} watchPath - 監視ディレクトリ
 * @returns {chokidar.FSWatcher}
 */
function startWatcher(watchPath) {
  const resolved = watchPath.replace(/^~/, os.homedir());

  const watcher = chokidar.watch(resolved, {
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

  watcher.on('add', (filePath) => {
    if (isJsonlFile(filePath)) {
      filePositions.set(filePath, 0);
      lineBuffers.set(filePath, '');
    }
  });

  watcher.on('unlink', (filePath) => {
    filePositions.delete(filePath);
    lineBuffers.delete(filePath);
  });

  watcher.on('change', (filePath) => {
    if (isJsonlFile(filePath)) {
      readNewLines(filePath);
    }
  });

  watcher.on('error', (err) => {
    console.error('[CodeGuard] ログ監視エラー:', err.message);
  });

  return watcher;
}

function isJsonlFile(filePath) {
  return filePath.endsWith('.jsonl');
}

/**
 * ファイルの新しい行を読み取り、承認リクエストを検出する
 */
function readNewLines(filePath) {
  let pos = filePositions.get(filePath) || 0;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return;
  }

  if (stat.size <= pos) return;

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(stat.size - pos);
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, pos);
  fs.closeSync(fd);

  filePositions.set(filePath, pos + bytesRead);

  // 前回の未完了行と結合
  const prev = lineBuffers.get(filePath) || '';
  const newContent = prev + buffer.slice(0, bytesRead).toString('utf8');
  const lines = newContent.split('\n');

  // 末尾の行は改行がない可能性があるのでバッファに残す
  const lastLine = lines.pop();
  lineBuffers.set(filePath, lastLine || '');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      processLogLine(obj);
    } catch (e) {
      // JSON パースエラーは無視（不正な行）
    }
  }
}

/**
 * JSONL の1行を解析し、承認リクエストを抽出する
 *
 * 実際に観察されたClaude Codeのセッションログ形式:
 * {
 *   "parentUuid": "...",
 *   "isSidechain": false,
 *   "message": {
 *     "role": "assistant",
 *     "content": [ { "type": "tool_use", "name": "Bash", "input": {...} } ]
 *   }
 * }
 */
function processLogLine(obj) {
  let detected = false;

  // パターン1（実際の形式）: message.role === "assistant" && message.content[]
  if (obj.message?.role === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_use' && WATCHED_TOOLS.has(block.name)) {
        handleToolUse(block.name, block.input || {});
        detected = true;
      }
    }
    if (detected) { parseSuccessCount++; return; }
  }

  // パターン2（旧形式フォールバック）: type === "assistant" && message.content[]
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_use' && WATCHED_TOOLS.has(block.name)) {
        handleToolUse(block.name, block.input || {});
        detected = true;
      }
    }
    if (detected) { parseSuccessCount++; return; }
  }

  // パターン3: content が直接配列
  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      if (block.type === 'tool_use' && WATCHED_TOOLS.has(block.name)) {
        handleToolUse(block.name, block.input || {});
        detected = true;
      }
    }
    if (detected) { parseSuccessCount++; return; }
  }

  // パターン4: tool_use が直接トップレベル
  if (obj.type === 'tool_use' && WATCHED_TOOLS.has(obj.name)) {
    handleToolUse(obj.name, obj.input || {});
    parseSuccessCount++;
    return;
  }

  // どのパターンにもマッチしなかった行（assistantメッセージのみカウント）
  const isAssistantMsg = obj.message?.role === 'assistant' || obj.type === 'assistant';
  if (isAssistantMsg) {
    parseFailCount++;
    // 失敗が10件を超えたらUIに警告をブロードキャスト
    if (parseFailCount === 10) {
      broadcast({
        type: 'warning',
        message: 'Claude Codeのログ形式が変わった可能性があります。一部のコマンドが検出できていないかもしれません。'
      });
    }
  }
}

// パース失敗カウンター（ログ形式変更検出用）
let parseFailCount = 0;
let parseSuccessCount = 0;

function getParseStats() {
  return { fail: parseFailCount, success: parseSuccessCount };
}

// 重複検出用（直近20件のキーを保持）
const recentEvents = [];
const DEDUP_WINDOW_MS = 3000;
const DEDUP_MAX = 20;

function isDuplicate(key) {
  const now = Date.now();
  // 古いエントリを削除
  while (recentEvents.length > 0 && now - recentEvents[0].ts > DEDUP_WINDOW_MS) {
    recentEvents.shift();
  }
  if (recentEvents.some(e => e.key === key)) return true;
  recentEvents.push({ key, ts: now });
  if (recentEvents.length > DEDUP_MAX) recentEvents.shift();
  return false;
}

/**
 * ツール使用情報を解析してブロードキャスト
 */
function handleToolUse(toolName, input) {
  const name = toolName.toLowerCase();

  // 重複チェック（同じコマンドが3秒以内に来たら無視）
  const dedupKey = name === 'bash'
    ? `bash:${input.command || ''}`
    : `${name}:${input.file_path || input.path || input.pattern || ''}`;
  if (isDuplicate(dedupKey)) return;

  let result;
  if (name === 'bash') {
    const cmd = input.command || '';
    const parsed = parseCommand(cmd);
    result = analyze(parsed);
  } else {
    result = analyze({}, { name, input });
  }

  broadcast(result);
}

module.exports = { startWatcher };

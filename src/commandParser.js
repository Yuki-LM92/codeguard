'use strict';

/**
 * シェルコマンド文字列を構造化データに分解するパーサー
 */

/**
 * コマンド文字列をパースして構造化データを返す
 * @param {string} raw - 生コマンド文字列
 * @returns {Object} パース済みコマンドデータ
 */
function parseCommand(raw) {
  if (!raw || typeof raw !== 'string') {
    return { raw: '', baseCommand: '', args: [], options: [], pipes: [], isChained: false, chainedCommands: [] };
  }

  const trimmed = raw.trim();

  // チェーンコマンドを分割（&&, ||, ; ただしパイプは別処理）
  const chainSplit = splitChained(trimmed);
  const isChained = chainSplit.length > 1;

  // メインコマンド（最初のもの）を詳細解析
  const mainParsed = parseSingleCommand(chainSplit[0]);

  return {
    raw: trimmed,
    ...mainParsed,
    isChained,
    chainedCommands: isChained ? chainSplit.slice(1).map(c => parseSingleCommand(c)) : []
  };
}

/**
 * チェーン演算子（&&, ||, ;）でコマンドを分割
 * パイプ(|)は分割しない（パイプラインとして扱う）
 */
function splitChained(cmd) {
  const parts = [];
  let current = '';
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < cmd.length) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      } else if (ch === ';') {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
    i++;
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * 単一コマンドをパース（パイプライン対応）
 */
function parseSingleCommand(cmd) {
  // パイプで分割
  const pipeParts = splitPipes(cmd);
  const pipes = pipeParts.slice(1).map(p => p.trim().split(/\s+/)[0]);

  // メイン部分（パイプの最初）を解析
  const main = pipeParts[0].trim();

  // リダイレクトを抽出
  const { command: withoutRedirect, redirects } = extractRedirects(main);

  // 環境変数プレフィックスを分離
  const { command: withoutEnv, envVars } = extractEnvVars(withoutRedirect);

  // コマンド置換の検出（$(...) またはバッククォート）
  // 例: rm -rf $(cat list.txt) や rm -rf `cat list.txt`
  const hasCommandSubstitution = /\$\(/.test(cmd) || /`[^`]+`/.test(cmd);

  // トークン分割
  const tokens = tokenize(withoutEnv);

  if (tokens.length === 0) {
    return {
      raw: cmd,
      baseCommand: '',
      subcommand: null,
      args: [],
      options: [],
      envVars,
      redirects,
      pipes,
      pipeTarget: pipes.length > 0 ? pipes[0] : null,
      hasRedirect: redirects.length > 0,
      redirectType: redirects.find(r => r.type === 'overwrite') ? 'overwrite'
        : redirects.find(r => r.type === 'append') ? 'append' : null,
      hasCommandSubstitution
    };
  }

  const baseCommand = tokens[0];
  const rest = tokens.slice(1);

  // オプション（-で始まるもの）と引数を分離
  const options = [];
  const args = [];
  let subcommand = null;
  let firstArgSeen = false;

  for (const token of rest) {
    if (token.startsWith('-')) {
      // 複合オプション（-rf → -r, -f）を展開
      if (token.startsWith('--') || token.length === 2) {
        options.push(token);
      } else {
        // -rf のような複合短縮オプション
        for (const ch of token.slice(1)) {
          options.push('-' + ch);
        }
      }
    } else {
      if (!firstArgSeen && !subcommand && isSubcommandCandidate(token)) {
        // パスや数値ではなく、純粋なコマンド語（git push の"push"など）のみサブコマンド扱い
        subcommand = token;
        firstArgSeen = true;
      } else {
        args.push(token);
      }
    }
  }

  return {
    raw: cmd,
    baseCommand,
    subcommand,
    args,
    options,
    envVars,
    redirects,
    pipes,
    pipeTarget: pipes.length > 0 ? pipes[0] : null,
    hasRedirect: redirects.length > 0,
    redirectType: redirects.find(r => r.type === 'overwrite') ? 'overwrite'
      : redirects.find(r => r.type === 'append') ? 'append' : null,
    hasCommandSubstitution
  };
}

/**
 * パイプ(|)でコマンドを分割（||は除く）
 */
function splitPipes(cmd) {
  const parts = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
    } else if (ch === '|' && next !== '|' && cmd[i - 1] !== '|' && !inSingleQuote && !inDoubleQuote) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current) parts.push(current);
  return parts;
}

/**
 * リダイレクトを抽出
 */
function extractRedirects(cmd) {
  const redirects = [];
  // >> (append), > (overwrite), 2>&1 などを検出
  const redirectPattern = /\s*(>>|>|2>&1|2>)\s*(\S*)/g;
  const command = cmd.replace(redirectPattern, (match, op, target) => {
    redirects.push({
      type: op === '>>' ? 'append' : 'overwrite',
      operator: op,
      target
    });
    return '';
  });

  return { command: command.trim(), redirects };
}

/**
 * 環境変数プレフィックスを分離（KEY=value command の形式）
 */
function extractEnvVars(cmd) {
  const envVars = {};
  const envPattern = /^((?:[A-Z_][A-Z0-9_]*=[^\s]*\s+)+)/;
  const match = cmd.match(envPattern);

  if (match) {
    const envString = match[1];
    const varPattern = /([A-Z_][A-Z0-9_]*)=([^\s]*)/g;
    let m;
    while ((m = varPattern.exec(envString)) !== null) {
      envVars[m[1]] = m[2];
    }
    return { command: cmd.slice(envString.length).trim(), envVars };
  }

  return { command: cmd, envVars };
}

/**
 * コマンド文字列をトークンに分割（クォート対応）
 */
function tokenize(cmd) {
  const tokens = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * サブコマンド候補かどうかを判定
 * パス（./dist, /home/..., ~/...）や数値は除外する
 */
function isSubcommandCandidate(token) {
  if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../') || token.startsWith('~')) return false;
  if (/^\d/.test(token)) return false;           // 数値始まり（777 等）
  if (token.includes('=')) return false;         // KEY=value 形式
  if (/[.*?[\]{}]/.test(token)) return false;   // glob パターン
  return true;
}

module.exports = { parseCommand, parseSingleCommand };

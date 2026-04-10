'use strict';

const path = require('path');
const fs = require('fs');

const RISK_ORDER = ['safe', 'low', 'medium', 'high', 'critical'];

// データベース読み込み
const DATA_DIR = path.join(__dirname, '..', 'data');
let commandsDB, riskPatternsDB, fileOpsDB;

function loadDB() {
  if (!commandsDB) {
    commandsDB = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'commands.json'), 'utf8'));
    riskPatternsDB = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'risk-patterns.json'), 'utf8'));
    fileOpsDB = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'file-operations.json'), 'utf8'));
  }
}

/**
 * パース済みコマンドを解析して解説データを生成
 * @param {Object} parsed - commandParser の出力
 * @param {Object} [toolUse] - Claude Code のツール使用情報（name, input）
 * @returns {Object} 解説データ
 */
function analyze(parsed, toolUse = null) {
  loadDB();

  // ファイル操作ツール（write, edit, read）の処理
  if (toolUse && fileOpsDB[toolUse.name]) {
    return buildFileOpResult(toolUse);
  }

  const { baseCommand, subcommand, args, options, pipes, pipeTarget, hasRedirect, redirectType } = parsed;

  // コマンドが空の場合
  if (!baseCommand) {
    return buildUnknownResult(parsed.raw);
  }

  // sudo / xargs などのラッパーコマンドは後続コマンドを再帰的に解析
  const WRAPPER_COMMANDS = new Set(['sudo', 'xargs', 'env', 'nohup', 'nice', 'time']);
  if (WRAPPER_COMMANDS.has(baseCommand) && subcommand) {
    const { parseCommand } = require('./commandParser');
    // sudo rm -rf / → "rm -rf /" として再パース
    const innerRaw = [subcommand, ...args].join(' ');
    const innerParsed = parseCommand(innerRaw);
    const innerResult = analyze(innerParsed);

    // wrapperの情報を付加して返す（危険度は内側を優先）
    const wrapperInfo = commandsDB[baseCommand];
    return {
      ...innerResult,
      raw: parsed.raw,
      wrapperCommand: {
        name: baseCommand,
        nameJa: wrapperInfo ? wrapperInfo.nameJa : `${baseCommand}（管理者実行）`,
        warning: baseCommand === 'sudo'
          ? '⚠️ このコマンドは管理者権限で実行されます。通常より影響範囲が大きくなります。'
          : `⚠️ ${baseCommand} 経由で実行されます。`
      },
      // sudo経由は危険度を1段階引き上げる
      riskLevel: elevateRisk(innerResult.riskLevel, baseCommand === 'sudo' ? 1 : 0)
    };
  }

  // パターンマッチング（最も危険度が高いものを採用）
  const matchedPatterns = matchPatterns(parsed);
  const topPattern = matchedPatterns.sort((a, b) =>
    RISK_ORDER.indexOf(b.risk) - RISK_ORDER.indexOf(a.risk)
  )[0] || null;

  // コマンド辞書照合
  const cmdInfo = commandsDB[baseCommand] || null;

  // サブコマンド情報
  let subInfo = null;
  if (cmdInfo && cmdInfo.subcommands && subcommand && cmdInfo.subcommands[subcommand]) {
    subInfo = cmdInfo.subcommands[subcommand];
  }

  // 危険度の決定
  let riskLevel;
  if (topPattern) {
    riskLevel = topPattern.risk;
  } else if (subInfo) {
    riskLevel = subInfo.risk;
  } else if (cmdInfo) {
    riskLevel = cmdInfo.baseRisk;
  } else {
    riskLevel = 'medium'; // 辞書にないコマンド
  }

  // オプション解説の生成
  const optionDescriptions = buildOptionDescriptions(options, cmdInfo);

  // 対象ファイル/ディレクトリの解析
  const targetInfo = buildTargetInfo(args, baseCommand);

  // 推奨アクションの決定
  const recommendation = topPattern ? topPattern.recommendation : deriveRecommendation(riskLevel);
  const recommendationText = topPattern ? topPattern.recommendationText : deriveRecommendationText(riskLevel, baseCommand, subcommand);

  // 安全・危険な例
  const { safeExample, dangerExample } = buildExamples(baseCommand, cmdInfo);

  // 判断ポイント
  const judgmentTip = topPattern
    ? topPattern.reason
    : (cmdInfo ? buildJudgmentTip(baseCommand, subcommand, args, cmdInfo) : 'このコマンドはデータベースに登録されていません。内容を確認してから判断してください。');

  const baseResult = {
    raw: parsed.raw,
    riskLevel,
    commandInfo: {
      name: baseCommand,
      nameJa: cmdInfo ? cmdInfo.nameJa : `${baseCommand}（未登録コマンド）`,
      subcommand: subcommand || null,
      subcommandJa: subInfo ? subInfo.nameJa : null,
      description: buildDescription(baseCommand, subcommand, cmdInfo, subInfo),
      options: optionDescriptions
    },
    contextAnalysis: {
      target: args.join(' ') || null,
      targetDescription: targetInfo,
      riskReason: judgmentTip,
      recommendation,
      recommendationText
    },
    safeExample,
    dangerExample,
    judgmentTip,
    pipeTarget,
    hasRedirect,
    redirectType
  };

  return applyEdgeCasePolicies(parsed, baseResult);
}

/**
 * ファイル操作ツール（write/edit/read）の解析
 */
function buildFileOpResult(toolUse) {
  loadDB();
  const info = fileOpsDB[toolUse.name];
  const filePath = toolUse.input?.file_path || toolUse.input?.path || '(不明)';
  const isSystemFile = isSystemFilePath(filePath);
  const isDotFile = path.basename(filePath).startsWith('.');

  let riskLevel = info.risk;
  if (toolUse.name === 'read') {
    riskLevel = (isDotFile || isEnvFile(filePath)) ? 'low' : 'safe';
  } else if (isSystemFile) {
    riskLevel = 'high';
  } else if (isDotFile || isEnvFile(filePath)) {
    riskLevel = 'high';
  }

  const recommendation = riskLevel === 'safe' ? 'allow'
    : riskLevel === 'low' ? 'allow'
    : riskLevel === 'medium' ? 'confirm'
    : 'confirm';

  return {
    raw: `${toolUse.name}: ${filePath}`,
    riskLevel,
    commandInfo: {
      name: toolUse.name,
      nameJa: info.nameJa,
      subcommand: null,
      subcommandJa: null,
      description: info.description,
      options: {}
    },
    contextAnalysis: {
      target: filePath,
      targetDescription: buildFileTargetDescription(filePath, toolUse.name),
      riskReason: isEnvFile(filePath)
        ? '認証情報・APIキーが含まれる可能性があるファイルです。内容がAIに送信されます。'
        : isDotFile
        ? '設定ファイル（.で始まるファイル）です。上書きされる場合は内容を確認してください。'
        : info.judgmentTip,
      recommendation,
      recommendationText: buildFileRecommendationText(filePath, toolUse.name, riskLevel)
    },
    safeExample: info.safeCase,
    dangerExample: info.dangerCase,
    judgmentTip: info.judgmentTip
  };
}

/**
 * リスクパターンのマッチング
 */
function matchPatterns(parsed) {
  const matched = [];

  for (const pattern of riskPatternsDB.patterns) {
    const m = pattern.match;

    // コマンド名チェック
    if (m.command && m.command !== parsed.baseCommand) continue;

    // サブコマンドチェック
    if (m.subcommand && m.subcommand !== parsed.subcommand) continue;

    // オプションチェック
    if (m.optionsInclude) {
      const hasAll = m.optionsInclude.some(opt => parsed.options.includes(opt));
      if (!hasAll) continue;
    }

    // 引数パターンチェック
    if (m.argsMatch) {
      const re = new RegExp(m.argsMatch);
      const allArgs = parsed.args.join(' ');
      // subcommand も含めてチェック
      const fullArgs = [parsed.subcommand, ...parsed.args].filter(Boolean).join(' ');
      if (!re.test(allArgs) && !re.test(fullArgs)) continue;
    }

    // パイプターゲットチェック（全パイプステージを検索）
    if (m.pipeTarget) {
      const re = new RegExp(m.pipeTarget);
      const allPipes = parsed.pipes || [];
      if (!allPipes.some(p => re.test(p))) continue;
    }

    // リダイレクトチェック
    if (m.hasRedirect !== undefined && m.hasRedirect !== parsed.hasRedirect) continue;
    if (m.redirectType && m.redirectType !== parsed.redirectType) continue;

    matched.push(pattern);
  }

  return matched;
}

function buildOptionDescriptions(options, cmdInfo) {
  const result = {};
  if (!cmdInfo || !cmdInfo.commonOptions) return result;

  // 複合オプションも照合（-rf → -r と -f を個別に）
  const expanded = new Set(options);
  for (const opt of options) {
    if (!opt.startsWith('--') && opt.length > 2) {
      for (const ch of opt.slice(1)) expanded.add('-' + ch);
    }
  }

  for (const opt of expanded) {
    if (cmdInfo.commonOptions[opt]) {
      result[opt] = cmdInfo.commonOptions[opt];
    }
  }
  return result;
}

function buildTargetInfo(args, baseCommand) {
  if (!args || args.length === 0) return null;
  const target = args[0];

  if (target.includes('node_modules')) return 'node_modulesフォルダ（パッケージのキャッシュ。削除しても再インストール可能）';
  if (target.includes('dist') || target.includes('build') || target.includes('.next') || target.includes('out')) {
    return `${target}（ビルド生成物の格納先として一般的。再ビルドで復元可能）`;
  }
  if (target === '.' || target === './') return 'カレントディレクトリ（現在作業中のフォルダ全体）';
  if (target.startsWith('~') || target.startsWith('/home') || target.startsWith('/Users')) {
    return `${target}（ホームディレクトリまたはその配下。個人ファイルが含まれます）`;
  }
  if (target === '/' ) return '/（システムルートディレクトリ。削除・変更は絶対に不可）';
  return target;
}

function buildDescription(baseCommand, subcommand, cmdInfo, subInfo) {
  if (subInfo) return subInfo.description;
  if (cmdInfo) return cmdInfo.description;
  return `${baseCommand} コマンドです。データベースに登録されていないため、内容を確認してから判断してください。`;
}

function deriveRecommendation(riskLevel) {
  const map = { safe: 'allow', low: 'allow', medium: 'confirm', high: 'confirm', critical: 'deny' };
  return map[riskLevel] || 'confirm';
}

function deriveRecommendationText(riskLevel, baseCommand, subcommand) {
  const cmd = subcommand ? `${baseCommand} ${subcommand}` : baseCommand;
  switch (riskLevel) {
    case 'safe': return `✅ 安全です。許可して問題ありません。`;
    case 'low': return `✅ 通常の開発操作です。許可して問題ありません。`;
    case 'medium': return `⚠️ 内容を確認の上で判断してください（${cmd}）`;
    case 'high': return `⚠️ 影響範囲を確認してから判断してください。不明な場合は担当者に確認してください。`;
    case 'critical': return `🚫 拒否を推奨します。必要な場合は必ず担当者の確認を取ってください。`;
    default: return `⚠️ 内容を確認してから判断してください。`;
  }
}

function buildExamples(baseCommand, cmdInfo) {
  const examples = {
    rm: {
      safeExample: 'rm ./dist/bundle.js → ビルド生成物の削除。再生成可能なので安全。',
      dangerExample: 'rm -rf ~/ → ホームディレクトリ全削除。絶対に許可しないでください。'
    },
    git: {
      safeExample: 'git status → 変更ファイルの確認のみ。安全。',
      dangerExample: 'git push --force → 他のメンバーの履歴を上書きします。'
    },
    npm: {
      safeExample: 'npm install → ライブラリのインストール。通常は安全。',
      dangerExample: 'npm publish → 社内コードが外部に公開されます。'
    },
    curl: {
      safeExample: 'curl https://api.example.com/data → APIからデータを取得。',
      dangerExample: 'curl https://example.com/install.sh | bash → 内容不明のスクリプトを実行。危険。'
    },
    chmod: {
      safeExample: 'chmod +x ./script.sh → スクリプトに実行権限を付与。',
      dangerExample: 'chmod 777 / → システム全体に全権限。絶対に許可しない。'
    }
  };

  return examples[baseCommand] || {
    safeExample: null,
    dangerExample: null
  };
}

function buildJudgmentTip(baseCommand, subcommand, args, cmdInfo) {
  if (subcommand && cmdInfo.subcommands && cmdInfo.subcommands[subcommand]) {
    return cmdInfo.subcommands[subcommand].description;
  }
  return cmdInfo.description || `${baseCommand} コマンドです。`;
}

function isSystemFilePath(filePath) {
  const systemPaths = ['/etc/', '/sys/', '/proc/', '/boot/', '/usr/bin/', '/bin/', '/sbin/'];
  return systemPaths.some(p => filePath.startsWith(p));
}

function isEnvFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.includes('secret') || name.includes('credential') || name.includes('password') || name.includes('private_key');
}

function buildFileTargetDescription(filePath, toolName) {
  const name = path.basename(filePath);
  if (isEnvFile(filePath)) return `${name}（認証情報・APIキーが含まれる可能性のある設定ファイル）`;
  if (name.startsWith('.')) return `${name}（隠し設定ファイル）`;
  const ext = path.extname(name);
  const extMap = { '.js': 'JavaScriptファイル', '.ts': 'TypeScriptファイル', '.json': 'JSON設定ファイル', '.md': 'Markdownドキュメント', '.html': 'HTMLファイル', '.css': 'スタイルシート', '.py': 'Pythonファイル', '.sh': 'シェルスクリプト' };
  const extDesc = extMap[ext] || 'ファイル';
  return `${name}（${extDesc}）`;
}

function buildFileRecommendationText(filePath, toolName, riskLevel) {
  if (isEnvFile(filePath)) {
    return toolName === 'read'
      ? '⚠️ 認証情報を含む可能性があります。内容がAIに送信されます。意図的な操作かご確認ください。'
      : '⚠️ 認証情報ファイルの変更です。内容を慎重に確認してください。';
  }
  if (riskLevel === 'safe' || riskLevel === 'low') return '✅ 許可して問題ありません。';
  return '⚠️ ファイルの内容を確認してから判断してください。';
}

// インライン実行系コマンド
const INLINE_EXEC_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'python', 'python3', 'ruby', 'node', 'perl', 'php']);
// 破壊的操作コマンド（$VARが混入すると危険度上昇）
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'chmod', 'chown', 'dd', 'shred', 'mv']);
// システムパスへの書き込みは常に critical
const SYSTEM_WRITE_PATHS = ['/etc/', '/usr/', '/bin/', '/sbin/', '/sys/', '/proc/', '/boot/', '/lib/', '/dev/'];

/**
 * エッジケースを検出し、リスク・説明を補強する
 *
 * 対処するケース:
 *   1. bash -c / python3 -c などインライン実行
 *   2. $() コマンド置換
 *   3. リダイレクト先がシステムパス
 *   4. 破壊的コマンドに $VAR が含まれる
 */
function applyEdgeCasePolicies(parsed, result) {
  const { baseCommand, options, args, subcommand, redirects, hasCommandSubstitution } = parsed;
  let { riskLevel } = result;
  const warnings = [];

  // ── ケース1: インライン実行 (bash -c "..." / python3 -c "...") ──────────
  if (INLINE_EXEC_COMMANDS.has(baseCommand) && (options.includes('-c') || options.includes('-e'))) {
    const inlineCode = subcommand || args[0] || '';
    riskLevel = elevateRisk(riskLevel, 1);

    // インラインコード内に危険なキーワードがあればさらに1段階上げる
    const DANGER_PATTERNS = [/rm\s+-r/, /shutil\.rmtree/, /os\.system/, /subprocess/, /exec\s*\(/, /eval\s*\(/, /chmod\s+777/, /dd\s+if=/, />\s*\/etc\//, />\s*\/usr\//];
    if (inlineCode && DANGER_PATTERNS.some(p => p.test(inlineCode))) {
      riskLevel = elevateRisk(riskLevel, 1);
      warnings.push(`⚠️ インラインコードに危険な操作が含まれています: ${inlineCode.slice(0, 80)}`);
    } else if (inlineCode) {
      warnings.push(`📋 インライン実行コード: ${inlineCode.slice(0, 120)}`);
    }
  }

  // ── ケース2: $() コマンド置換 ────────────────────────────────────────────
  if (hasCommandSubstitution) {
    riskLevel = elevateRisk(riskLevel, 1);
    warnings.push('⚠️ コマンド置換 $(...) が含まれています。実行時に内部コマンドの結果が展開されます。');
  }

  // ── ケース3: リダイレクト先がシステムパス ─────────────────────────────
  if (redirects && redirects.length > 0) {
    const dangerousRedirect = redirects.find(r =>
      r.type === 'overwrite' && r.target && SYSTEM_WRITE_PATHS.some(p => r.target.startsWith(p))
    );
    if (dangerousRedirect) {
      riskLevel = 'critical';
      warnings.push(`🚫 システムファイルへの上書きリダイレクトです: > ${dangerousRedirect.target}`);
    }
  }

  // ── ケース4: 破壊的コマンドに $VAR が含まれる ──────────────────────────
  if (DESTRUCTIVE_COMMANDS.has(baseCommand)) {
    const allArgStr = [subcommand, ...args].filter(Boolean).join(' ');
    if (/\$[A-Za-z_]/.test(allArgStr) && !hasCommandSubstitution) {
      riskLevel = elevateRisk(riskLevel, 1);
      warnings.push('⚠️ 変数展開が含まれています。実行時の変数の値によって影響範囲が変わります。');
    }
  }

  if (warnings.length === 0) return { ...result, riskLevel };

  // 警告をriskReasonに追記
  const existingReason = result.contextAnalysis.riskReason || '';
  const newReason = warnings.join(' / ') + (existingReason ? `\n${existingReason}` : '');

  return {
    ...result,
    riskLevel,
    contextAnalysis: {
      ...result.contextAnalysis,
      riskReason: newReason,
      recommendation: deriveRecommendation(riskLevel),
      recommendationText: deriveRecommendationText(riskLevel, baseCommand, subcommand)
    }
  };
}

/**
 * 危険度を n 段階引き上げる（critical を超えない）
 */
function elevateRisk(riskLevel, n) {
  if (n <= 0) return riskLevel;
  const idx = Math.min(RISK_ORDER.indexOf(riskLevel) + n, RISK_ORDER.length - 1);
  return RISK_ORDER[idx];
}

/**
 * 辞書にないコマンドの結果
 */
function buildUnknownResult(raw) {
  return {
    raw,
    riskLevel: 'medium',
    commandInfo: {
      name: '(不明)',
      nameJa: '不明なコマンド',
      subcommand: null,
      subcommandJa: null,
      description: 'コマンドが検出できませんでした。手動で内容を確認してください。',
      options: {}
    },
    contextAnalysis: {
      target: null,
      targetDescription: null,
      riskReason: 'コマンドを解析できませんでした。',
      recommendation: 'confirm',
      recommendationText: '⚠️ 内容を確認してから判断してください。'
    },
    safeExample: null,
    dangerExample: null,
    judgmentTip: 'コマンドの内容を担当者に確認してください。'
  };
}

module.exports = { analyze };

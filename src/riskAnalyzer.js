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
    judgmentTip: info.judgmentTip,
    judgmentHints: buildJudgmentHints(toolUse.name, null, [filePath], [], riskLevel)
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

/**
 * 非エンジニア向けの判断ヒントを生成する
 * @param {string} baseCommand
 * @param {string|null} subcommand
 * @param {string[]} args
 * @param {string[]} options
 * @param {string} riskLevel
 * @param {string[]} edgeWarnings - エッジケース検出で追加された警告
 * @returns {{ checkpoints: string[], ifUnsure: string }}
 */
function buildJudgmentHints(baseCommand, subcommand, args, options, riskLevel, edgeWarnings = []) {
  const checkpoints = [];
  const allArgs = args.join(' ');

  // ── ファイル削除 ───────────────────────────────────────
  if (baseCommand === 'rm') {
    if (/node_modules|\.next|dist\/|build\/|\.cache|\/tmp|\/temp/i.test(allArgs)) {
      checkpoints.push('削除対象はビルドの一時ファイルやキャッシュです。通常は安全で、再実行で復元できます。');
    } else {
      checkpoints.push('削除するファイル・フォルダはGitで管理されていますか？Gitで管理されていれば削除後も復元できます。');
      checkpoints.push('対象が dist/ build/ node_modules/ などの一時ファイルでない場合は、削除前に内容を確認してください。');
    }
  }

  // ── Git ────────────────────────────────────────────────
  if (baseCommand === 'git') {
    if (subcommand === 'push') {
      checkpoints.push('プッシュ先のブランチは main / master などチームで共有しているブランチですか？');
      if (options.some(o => ['--force', '-f', '--force-with-lease'].includes(o))) {
        checkpoints.push('強制プッシュは他のメンバーの作業履歴を書き換える可能性があります。チームに確認しましたか？');
      }
    }
    if (subcommand === 'reset') {
      checkpoints.push('まだコミット（保存）していない変更がある場合、すべて失われます。');
      checkpoints.push('git stash コマンドで変更を一時退避してからリセットすることも検討してください。');
    }
    if (subcommand === 'clean') {
      checkpoints.push('Gitで追跡されていない新しいファイルが削除されます。大切なファイルが混ざっていませんか？');
    }
    if (subcommand === 'stash') {
      checkpoints.push('退避（stash）した作業内容を削除すると元に戻せません。git stash list で内容を確認してください。');
    }
  }

  // ── npm / pnpm / bun スクリプト実行 ───────────────────
  if (['npm', 'pnpm', 'bun', 'yarn'].includes(baseCommand) && subcommand === 'run') {
    if (/deploy|release|publish|prod/i.test(allArgs)) {
      checkpoints.push('本番環境へのデプロイ・リリース操作です。今実行してよいタイミングか確認してください。');
    } else {
      checkpoints.push('package.json の「scripts」セクションで、このスクリプト名の内容を確認できます。');
      checkpoints.push('clean / purge / drop といったスクリプトはデータを削除する可能性があります。注意して確認してください。');
    }
  }

  // ── ネットワーク取得 ───────────────────────────────────
  if (['curl', 'wget'].includes(baseCommand)) {
    checkpoints.push('アクセス先のURLは信頼できるサイトですか？見覚えのないURLへのアクセスは注意が必要です。');
    checkpoints.push('コマンドの末尾に「| bash」「| sh」が付いている場合、ダウンロードした内容をそのまま実行します。特に慎重に確認してください。');
  }

  // ── シェル直接実行（bash -c など）──────────────────────
  if (['bash', 'sh', 'zsh'].includes(baseCommand) && options.includes('-c')) {
    checkpoints.push('実行しようとしているコマンドの内容を理解していますか？');
    checkpoints.push('わからない場合は、Claude Codeに「このコマンドは何をしますか？日本語で説明してください」と聞いてみましょう。');
  }

  // ── Python / Node インライン実行 ──────────────────────
  if (['python', 'python3', 'ruby', 'node'].includes(baseCommand) && options.some(o => ['-c', '-e'].includes(o))) {
    checkpoints.push('インラインで実行されるコードの内容を確認してください。');
    checkpoints.push('ファイルの削除・書き換えや外部への通信が含まれていないか確認しましょう。');
  }

  // ── 権限変更 ───────────────────────────────────────────
  if (baseCommand === 'chmod') {
    checkpoints.push('「777」はすべての人が読み書き実行できる、最も緩い権限設定です。本当に必要ですか？');
    if (options.includes('-R')) {
      checkpoints.push('「-R」はフォルダ内のすべてのファイルに適用されます。対象フォルダが正しいか確認してください。');
    }
  }

  // ── リモート接続 ──────────────────────────────────────
  if (['ssh', 'scp'].includes(baseCommand)) {
    checkpoints.push('接続先のサーバーアドレスは正しいですか？本番サーバーへの接続ではありませんか？');
  }

  // ── Docker ────────────────────────────────────────────
  if (baseCommand === 'docker') {
    if (subcommand === 'run') {
      checkpoints.push('実行するDockerイメージは信頼できる公式イメージですか？');
    }
    if (subcommand === 'exec') {
      checkpoints.push('本番環境で稼働中のコンテナに対して操作していませんか？');
    }
  }

  // ── クラウド操作（AWS / GCP / Azure）─────────────────
  if (['aws', 'gcloud', 'az'].includes(baseCommand)) {
    checkpoints.push('操作対象の環境は本番（production）ではなく、開発・テスト環境ですか？');
    checkpoints.push('削除・変更の操作の場合、バックアップや復元手段はありますか？');
  }

  // ── Kubernetes ────────────────────────────────────────
  if (baseCommand === 'kubectl') {
    checkpoints.push('現在接続しているクラスターを確認してください（kubectl config current-context）。本番環境ではありませんか？');
    if (subcommand === 'delete') {
      checkpoints.push('削除するリソース名を再確認してください。「--all」オプションがあるとすべてが削除されます。');
    }
  }

  // ── Terraform ─────────────────────────────────────────
  if (baseCommand === 'terraform') {
    checkpoints.push('操作対象のインフラは本番環境ですか？');
    if (subcommand === 'apply') {
      checkpoints.push('「terraform plan」を先に実行して変更内容を確認しましたか？');
    }
    if (subcommand === 'destroy') {
      checkpoints.push('これを実行するとすべてのサーバー・データベースが削除されます。本当に意図した操作ですか？');
    }
  }

  // ── デプロイ系 ────────────────────────────────────────
  if (['firebase', 'vercel', 'supabase'].includes(baseCommand) && subcommand === 'deploy') {
    checkpoints.push('デプロイ先は本番環境（production）ですか？テスト環境への意図したデプロイですか？');
  }

  // ── macOS AppleScript ────────────────────────────────
  if (baseCommand === 'osascript') {
    checkpoints.push('AppleScriptはmacOS上でほぼ何でもできます。スクリプトの内容を確認しましたか？');
    checkpoints.push('内容が不明な場合は必ず拒否し、Claude Codeに「このスクリプトは何をしますか？」と聞きましょう。');
  }

  // ── DD（ディスク破壊）────────────────────────────────
  if (baseCommand === 'dd') {
    checkpoints.push('「of=/dev/...」がついている場合、ディスクを直接上書きします。絶対に確認してから実行してください。');
  }

  // ── Redis flushall ────────────────────────────────────
  if (baseCommand === 'redis-cli' && (subcommand === 'flushall' || subcommand === 'flushdb')) {
    checkpoints.push('接続先のRedisは本番環境ですか？実行するとすべてのデータが消えます。');
  }

  // ── nc（ポート開放）──────────────────────────────────
  if (['nc', 'netcat'].includes(baseCommand) && options.includes('-l')) {
    checkpoints.push('外部からの接続を受け入れるポートを開きます。ポート番号と用途を把握していますか？');
  }

  // ── crontab -r ────────────────────────────────────────
  if (baseCommand === 'crontab' && options.includes('-r')) {
    checkpoints.push('「crontab -l」で現在登録されているタスクを確認しましたか？-r で全タスクが削除されます。');
  }

  // ── ファイル操作ツール（write / edit / read）─────────
  if (baseCommand === 'write') {
    checkpoints.push('上書きされるファイルに大切な内容がある場合は、事前にGitでバックアップしておくと安心です。');
    checkpoints.push('設定ファイル（.envや.shなど）の場合は内容を特に慎重に確認してください。');
  }
  if (baseCommand === 'edit') {
    checkpoints.push('変更される内容はClaude Codeに依頼した作業と一致していますか？');
  }
  if (baseCommand === 'read') {
    checkpoints.push('読み取られるファイルに秘密鍵やAPIキーが含まれている場合、内容がAIに送信されます。問題ありませんか？');
  }

  // ── エッジケース警告からのヒント ─────────────────────
  if (edgeWarnings.some(w => w.includes('コマンド置換'))) {
    checkpoints.push('コマンドに「$(...)」が含まれています。実行時に別コマンドの結果が展開されます。内容を確認してください。');
  }

  // ── 全共通：判断に迷ったときのアドバイス ─────────────
  let ifUnsure;
  switch (riskLevel) {
    case 'safe':
      ifUnsure = '✅ 安全です。安心して許可してください。';
      break;
    case 'low':
      ifUnsure = '✅ 通常の開発操作です。特に問題はありません。';
      break;
    case 'medium':
      ifUnsure = 'Claude Codeに「今何をしようとしているか、日本語で説明してください」と聞いてから判断しましょう。';
      break;
    case 'high':
      ifUnsure = '確信が持てない場合は拒否してください。Claude Codeに理由を確認してから改めて判断しましょう。拒否してもClaudeは別の方法を考えてくれます。';
      break;
    case 'critical':
      ifUnsure = '少しでも不安があれば迷わず拒否してください。Claude Codeに「なぜこの操作が必要か説明してください」と聞き、納得してから許可しましょう。';
      break;
    default:
      ifUnsure = '不明なコマンドです。Claude Codeに何をしようとしているか確認してから判断してください。';
  }

  return { checkpoints, ifUnsure };
}

// インライン実行系コマンド
const INLINE_EXEC_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'python', 'python3', 'ruby', 'node', 'perl', 'php']);
// 破壊的操作コマンド（$VARが混入すると危険度上昇）
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'chmod', 'chown', 'dd', 'shred', 'mv']);
// システムパスへの書き込みは常に critical
const SYSTEM_WRITE_PATHS = ['/etc/', '/usr/', '/bin/', '/sbin/', '/sys/', '/proc/', '/boot/', '/lib/', '/dev/'];
// /dev/ 配下でも書き込みが安全な仮想デバイス（ゴミ箱・標準入出力）
// 例: ls 2>/dev/null、command >/dev/null 2>&1 などは誤検知しない
const DEV_SAFE_WRITE_TARGETS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

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
  // /dev/null, /dev/stdin, /dev/stdout, /dev/stderr への書き込みは安全（誤検知防止）
  // それ以外の /dev/ (/dev/sda 等) と /etc/, /usr/ 等は危険
  // overwrite (>) と append (>>) の両方を検査する（>> /etc/passwd も危険）
  if (redirects && redirects.length > 0) {
    const dangerousRedirect = redirects.find(r => {
      if (!r.target) return false;
      if (DEV_SAFE_WRITE_TARGETS.has(r.target)) return false; // /dev/null 等はセーフ
      return (r.type === 'overwrite' || r.type === 'append') &&
        SYSTEM_WRITE_PATHS.some(p => r.target.startsWith(p));
    });
    if (dangerousRedirect) {
      const opSymbol = dangerousRedirect.type === 'append' ? '>>' : '>';
      riskLevel = 'critical';
      warnings.push(`🚫 システムファイルへの書き込みリダイレクトです: ${opSymbol} ${dangerousRedirect.target}`);
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

  const judgmentHints = buildJudgmentHints(baseCommand, subcommand, args, options, riskLevel, warnings);

  if (warnings.length === 0) return { ...result, riskLevel, judgmentHints };

  // 警告をriskReasonに追記
  const existingReason = result.contextAnalysis.riskReason || '';
  const newReason = warnings.join(' / ') + (existingReason ? `\n${existingReason}` : '');

  return {
    ...result,
    riskLevel,
    judgmentHints,
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

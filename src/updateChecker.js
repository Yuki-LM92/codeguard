'use strict';

const https = require('https');

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/Yuki-LM92/codeguard/main/package.json';

/**
 * バージョン文字列を比較する（"1.2.3" 形式）
 * @returns {number} latest > current なら正、等しければ0、current > latest なら負
 */
function compareVersions(current, latest) {
  const toNums = v => v.split('.').map(Number);
  const [ca, cb, cc] = toNums(current);
  const [la, lb, lc] = toNums(latest);
  if (la !== ca) return la - ca;
  if (lb !== cb) return lb - cb;
  return lc - cc;
}

/**
 * GitHubから最新バージョンを取得する
 */
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(GITHUB_RAW_URL, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          resolve(pkg.version);
        } catch (e) {
          reject(new Error('バージョン情報のパースに失敗'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('タイムアウト')); });
  });
}

/**
 * アップデートをチェックし、新しいバージョンがあれば broadcast する
 * @param {string} currentVersion - 現在のバージョン（package.json から取得）
 * @param {Function} broadcastFn - wsServer の broadcastSystem 関数
 */
async function checkForUpdates(currentVersion, broadcastFn) {
  try {
    const latestVersion = await fetchLatestVersion();

    if (compareVersions(currentVersion, latestVersion) > 0) {
      console.log(`\n📦 CodeGuard の新しいバージョンがあります: v${currentVersion} → v${latestVersion}`);
      console.log('   更新方法: git pull（codeguard フォルダで実行）\n');

      broadcastFn('update_available', {
        currentVersion,
        latestVersion,
        updateCommand: 'cd ~/ClaudeCode/codeguard && git pull'
      });
    }
  } catch (e) {
    // ネットワーク未接続や GitHub が落ちていても起動に影響させない
  }
}

module.exports = { checkForUpdates };

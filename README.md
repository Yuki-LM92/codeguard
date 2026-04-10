# CodeGuard

Claude Codeが実行しようとするコマンドをリアルタイムで監視し、リスクをブラウザで可視化するローカルセキュリティツールです。

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

## 概要

Claude Codeはファイル操作・コマンド実行・ネットワーク通信など強力な機能を持っています。CodeGuardはClaude Codeのセッションログを監視し、実行されたコマンドのリスクレベルをリアルタイムでブラウザに表示します。

**CodeGuardはClaude Codeを止めたり、コマンドをブロックしたりしません。** あくまで「今何が起きているか」を可視化する観察ツールです。

```
Claude Code ──(ログ書き込み)──▶ ~/.claude/projects/*.jsonl
                                        │
                              CodeGuard (監視)
                                        │
                              ブラウザ (リスク表示)
```

## リスクレベル

| レベル | 色 | 例 |
|--------|----|----|
| 安全 | 🟢 緑 | ls, cat, git status |
| 低リスク | 🔵 青 | git commit, npm install |
| 注意 | 🟡 黄 | mv, curl, npm run |
| 高リスク | 🟠 橙 | git push, rm, chmod |
| 危険 | 🔴 赤 | rm -rf, curl \| bash, eval |

## 要件

- **Node.js v18以上**（確認: `node -v`）
- **Claude Code**（対象のセッションログを生成するツール）
- macOS / Windows 対応

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/Yuki-LM92/codeguard.git
cd codeguard

# 依存パッケージをインストール
npm install

# グローバルインストール（どこからでも起動できるように）
npm install -g .
```

## 使い方

```bash
# 起動（自動でブラウザが開きます）
codeguard

# ブラウザが開かない場合は手動でアクセス
# http://localhost:19280
```

起動後はClaude Codeを普段通りに使うだけです。コマンドが実行されるたびにブラウザのパネルに表示されます。

## アンインストール

```bash
npm uninstall -g codeguard
```

## セキュリティ

CodeGuardは以下の設計でセキュリティを確保しています:

- **ローカル完結**: すべての処理はあなたのPC内で完結します。外部サーバーへのデータ送信はありません
- **読み取り専用**: セッションログファイルを読み取るだけで、Claude Codeの動作には一切干渉しません
- **ローカルホスト限定**: WebサーバーとWebSocketは `127.0.0.1`（自分のPCのみ）でのみ待ち受けます
- **最小依存**: 使用ライブラリは `chokidar`・`express`・`ws` の3つのみ
- **オープンソース**: このリポジトリでコード全体を確認できます

詳しくは [guide.html](./guide.html) をブラウザで開いてご覧ください。

## ライセンス

MIT

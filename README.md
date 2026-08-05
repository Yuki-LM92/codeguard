# CodeGuard

**Claude Codeが今なにをしているのか、日本語で見えるようにするツールです。**

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

Claude Codeを使い始めたばかりだと、「勝手にファイルを消したりしないかな」「このコマンド、実行して大丈夫？」と不安になります。CodeGuardは、Claude Codeが実行した操作をリアルタイムで拾い、**危険度を5段階の色で表示**します。

```
Claude Code ──(記録)──▶ ~/.claude/projects/*.jsonl
                                │
                          CodeGuard（読むだけ）
                                │
                          ブラウザに色付きで表示
```

> **CodeGuardはClaude Codeを止めたり、操作をブロックしたりしません。**
> 記録を読んで表示するだけの、完全に受け身の観察ツールです。

---

## いちばん簡単な始め方

ターミナルに、これを貼り付けて実行するだけです。

```bash
npx github:Yuki-LM92/codeguard
```

自動でブラウザが開きます。**インストール作業は不要**で、実行するたびに最新版が使われます。

開かない場合は http://localhost:19280 を手動で開いてください。

### 使い方は3ステップ

1. **この画面を開いたままにしておきます**
2. **別のターミナルで、いつも通りClaude Codeを使います**
3. Claudeが何か実行するたび、ブラウザに色付きで表示されます

終わるときはターミナルで `Ctrl + C` を押します。

---

## 危険度の見かた

| 表示 | 意味 | 例 |
|------|------|-----|
| 🟢 安全 | 見るだけ。何も変わりません | `ls`, `cat`, `git status` |
| 🔵 低リスク | 変更するが、取り消せます | `git commit`, `npm install` |
| 🟡 注意 | 中身が変わります | `mv`, `curl`, `npm run` |
| 🟠 高リスク | 取り消しにくい操作です | `git push`, `rm`, `chmod` |
| 🔴 危険 | 元に戻せない可能性があります | `rm -rf`, `curl \| bash`, `eval` |

赤が出たときは、**Claude Codeの画面に戻って承認する前に、一度手を止めて内容を読んでください。**

画面下部の入力欄にコマンドを打つと、その場で解説を試せます。まずは `rm -rf ./dist` などを入れてみると、どう表示されるか掴めます。

---

## 動作要件

- **Node.js v18以上** — ターミナルで `node -v` を実行して確認できます
- **Claude Code**
- macOS / Windows / Linux

Node.jsが入っていない場合は [nodejs.org](https://nodejs.org/) からインストールしてください。

---

## よくある質問

**Q. 何も表示されません**
Claude Codeをまだ一度も使っていない場合、記録がないため何も出ません。別のターミナルでClaude Codeを起動し、何か操作してみてください。

**Q. 私のコードや会話は外部に送信されますか？**
いいえ。すべてPC内で完結します。外部に送信されるものはありません。

**Q. Claude Codeの動作が遅くなりませんか？**
なりません。CodeGuardは記録ファイルを読むだけで、Claude Codeには一切干渉しません。

**Q. ポート19280が使われていると言われました**
`npx github:Yuki-LM92/codeguard --port 20000` のように別の番号を指定してください。

---

## オプション

```bash
codeguard --port 20000       # ポート番号を変える
codeguard --no-open          # ブラウザを自動で開かない
codeguard --no-update-check  # 起動時の更新確認をしない
codeguard --help             # ヘルプを表示
```

設定は `~/.codeguard/config.json` に保存され、次回以降も引き継がれます。

---

## セキュリティ

- **ローカル完結** — すべての処理はPC内で完結。外部サーバーへの送信はありません
- **読み取り専用** — 記録ファイルを読むだけ。Claude Codeの動作に干渉しません
- **ローカルホスト限定** — Webサーバーは `127.0.0.1`（自分のPCのみ）で待ち受けます
- **最小依存** — 使用ライブラリは `chokidar`・`express`・`ws` の3つのみ
- **オープンソース** — コード全体をこのリポジトリで確認できます

唯一の外部通信は起動時のバージョン確認（GitHub）です。`--no-update-check` で無効にできます。

詳しくは [guide.html](./guide.html) をブラウザで開いてご覧ください。

---

## 開発者向け

```bash
git clone https://github.com/Yuki-LM92/codeguard.git
cd codeguard
npm install
npm test     # テスト38件
npm start
```

グローバルインストールする場合：

```bash
npm install -g .
codeguard
```

## ライセンス

MIT

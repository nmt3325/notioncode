# Notion AI × OpenCode 標準チャット

OpenCode の標準チャット画面・セッション・履歴をそのまま使い、入力を Notion AI に送り、返答を通常の assistant メッセージとして表示するプラグインです。推論とツール選択は Notion AI が担当します。ファイル編集は同梱 MCP が実際の OpenCode native tools で行い、ローカル側の二重 LLM 推論は行いません。

```text
OpenCode 標準チャット → Notion プロバイダー → Notion AI (token_v2)
                                              ↓ ツール呼び出し
手動設定の公開 HTTPS /mcp → 同梱 MCP → 専用 Bun worker → OpenCode native tools
```

## 前提

- **OpenCode 1.18.29**、Node.js 22+、Git。Linux で検証。
- Notion AI を利用できるアカウントの `token_v2`。公式 integration token とは別です。
- Notion から到達できる **公開 HTTPS URL**。トンネル・DNS・TLS は手動で用意します。
- 初回起動時に GitHub / npm への接続が必要です。固定された実行用 OpenCode ソースと依存関係を自動取得します。
- Bun 1.3.14 は platform-specific optional dependency の実行ファイルを直接利用します。postinstall は不要です。optional dependencies を省略する場合は `OPENCODE_MCP_BUN` に同バージョンの実行ファイルを指定してください。

Notion Web 内部 API を利用しています。公式の安定 API ではなく、変更時には追従が必要です。現在の接続先は app.notion.com です。

## ビルド済みパッケージの導入（推奨）

[Build の成功した実行](https://github.com/nmt3325/notioncode/actions/workflows/build.yml) の Artifacts から ZIP をダウンロードして展開します。展開先で Linux は `sha256sum --check SHA256SUMS`、macOS は `shasum -a 256 -c SHA256SUMS` で検証できます。プラグイン自体は編集対象プロジェクトの外に置いてください。

```sh
mkdir -p "$HOME/.local/share/notioncode"
cd "$HOME/.local/share/notioncode"
npm init -y
npm install --ignore-scripts --omit=dev /path/to/opencode-mcp-bridge-0.5.0.tgz
node -p 'require("node:url").pathToFileURL(require.resolve("opencode-mcp-bridge")).href'
```

`/path/to/...` は展開した tarball の実際のパスです。最後に出力された file URL を既存の OpenCode 設定の `plugin` 配列に追加してください。通常は `~/.config/opencode/opencode.json` または `opencode.jsonc` です。**既存ファイルが `.jsonc` ならそのファイルを編集し、別の `.json` を作らないでください。**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/notioncode/node_modules/opencode-mcp-bridge/dist/plugin.js"]
}
```

既存項目は残し、`$schema` と `plugin` は同じ一つの `{}` に入れます。`{...}, {...}` と二つのトップレベルオブジェクトに分ける形式は無効です。

## ソースからの導入

このパッケージはまだ npm に公開していません。ソース版は次のようにビルドします。プラグイン自体は編集対象プロジェクトの外に配置してください。

```sh
git clone --branch main https://github.com/nmt3325/notioncode.git "$HOME/.local/share/opencode-notion-plugin"
cd "$HOME/.local/share/opencode-notion-plugin"
npm ci --ignore-scripts
npm run build
```

OpenCode 設定の既存項目を残して、ビルド済みファイルの絶対 file URL を追加します。

```json
{
  "plugin": ["file:///absolute/path/to/opencode-notion-plugin/dist/plugin.js"]
}
```

`npm pack` は `dist`、Notion クライアント、実行アダプター、setup スクリプトを一つの tarball にまとめます。公開済みパッケージを使う段階では通常の npm プラグイン指定に置き換えられます。未ビルドの Git URL を `--ignore-scripts` でインストールしても `dist` は生成されません。

## Cookie と公開 URL

リポジトリ外の `~/.config/opencode/notion-account.json` などに保存します。

```json
{
  "token_v2": "YOUR_TOKEN_V2",
  "space_id": "OPTIONAL_NOTION_WORKSPACE_ID"
}
```

`space_id` は省略可能です。利用ワークスペースを固定する場合は指定してください。トークンをチャット・プロジェクト設定・Git に書かないでください。

```sh
chmod 600 "$HOME/.config/opencode/notion-account.json"
export NOTION_ACCOUNT_FILE="$HOME/.config/opencode/notion-account.json"
export OPENCODE_NOTION_MCP_URL='https://opencode.example.com/mcp'
cd /absolute/path/to/your/project
opencode
```

`NOTION_TOKEN_V2` 環境変数も利用でき、account file より優先されます。

公開 URL の `/mcp` を **`http://127.0.0.1:8787/mcp`** に転送してください。Authorization、Mcp-Session-Id、Streamable HTTP を透過させます。URL に資格情報・クエリー・フラグメントは含められません。

起動時にプラグインが自動で行うこと:

1. 必要な native runtime の取得・固定バージョン検証。
2. 専用 worker と認証付き MCP HTTP サーバーの起動。
3. プロジェクト名＋パスのハッシュを含む専用接続の Notion への登録または再利用。
4. その接続の読み取り・書き込み自動実行の有効化。
5. `notion` エージェントと `notion-ai/chat` の既定設定。

既存セッションで別モデルを明示選択している場合は標準 UI から Notion AI を選んでください。セットアップ失敗時も Notion プロバイダーに設定エラーを返し、別のローカル LLM へ黙って切り替えません。既存の他の Notion 接続を乗っ取ったり、権限を変更したりはしません。

## モデルを選ぶ

OpenCode の `/models`（標準モデル選択）で **Notion AI** の一覧から選びます。GPT、Claude、Gemini、Kimi、Grok、DeepSeek、GLM 系の選択可能な全カタログ項目を登録します。High / Medium / Low などもカタログにある場合は別の選択肢になります。モデル変更は次の新しいメッセージから反映され、Notion の会話は同じまま継続します。

- 表示名だけでなく、選んだモデルを Notion の設定に毎ターン明示して送ります。
- `Notion AI · Configured default (...)` はプラグイン設定の既定モデルです。Notion の自動モデル選択という意味ではありません。`model` オプション / `NOTION_DEFAULT_MODEL` がこの既定値を決めます。
- OpenCode 設定のトップレベルに例えば `"model": "notion-ai/gpt-5.4"` を追加すると、起動時のモデルを固定できます。既存の同じ JSON オブジェクト内に追加してください。プラグインは明示された Notion モデル設定を上書きしません。
- `Notion local metadata` はタイトル・要約などのローカル補助用です。会話用モデルとしては選ばないでください。
- 完了済みメッセージを別モデルで再実行しません。変更後は新しいメッセージを送ってください。

通常の一覧は同梱の Notion Web モデルレジストリの **production-pickable な42項目**です。Notion が通常の選択画面には出していない項目も必要なら、プラグインの tuple オプションに `"includeUnlistedModels": true` を指定すると production-callable な全75項目を表示します（未掲載のモデルには表示上の注意書きが付きます）。

**カタログとアカウントでの利用権限は別です。** 一覧はログインアカウントの許可モデルをリアルタイムに取得したものではなく、同梱のレジストリスナップショットです。Notion 側で提供終了・権限制限されているモデルはエラーになることがあります。その際に別モデルへ黙って切り替えません。新規モデルの追加にはカタログ更新が必要です。

### インストール済み版を更新する

OpenCode を正常終了し、最新版の Actions artifact をダウンロード・展開して実行します。

```sh
cd "$HOME/.local/share/notioncode"
npm install --ignore-scripts --omit=dev /path/to/opencode-mcp-bridge-0.5.0.tgz
```

その後、認証・公開URLの環境変数を設定した同じシェルからプロジェクトで OpenCode を再起動します。`plugin` の file URL は変わりません。既存の認証ファイルや `~/.local/state/opencode-notion` の会話状態は削除しないでください。

## リアルタイム表示とトークン情報（0.5.0）

モデル選択は 0.4.0 で追加済みです。0.5.0 は以下を別の変更として追加します。

- **返答の途中表示**：Notion が返した公開テキストを受信し次第、標準チャットへ反映します。上流が最終返答しか返さない場合は最終表示のままです。Agent Service の場合はポーリング間隔に従います。
- **実行操作の表示**：このプラグインの MCP を通った native ジョブの実行中・完了・失敗などを、標準ツールカードに表示します。安全に整形した引数・結果を含みますが、表示からツールを再実行しません。Notion 自体のツール、他の MCP 接続、独立した制御 RPC の全履歴は表示対象外です。
- **Context のトークン数**：Notion が報告した最後の推論の入力・出力・キャッシュ使用量を反映します。内部の全推論の合計や、会話全体のコンテキスト量という意味ではありません。繰り返し届く累積値は二重加算しません。
- **％と料金の制約**：応答に含まれるコンテキスト上限・入力予算は保存しますが、標準サイドバーの分母へ動的に反映する部分は未対応です。`0% used` / `$0.00 spent` は標準 UI の未取得・未課金設定時の表示であり、実測のゼロや無料という意味ではありません。数値が未取得、または出力ゼロのターンでは、前のトークン数が残る場合もあります。

固定の 200K コンテキストを全モデルの実測値として扱うことはやめ、未確認の上限は不明のままにしています。OpenCode 本体・標準 UI は変更していません。詳細は [live-ui.md](live-ui.md) / [usage-ui.md](usage-ui.md) を参照してください。

## 全許可モードと境界

初期版は **全許可モード固定**。`read` / `write` / `edit` / `glob` / `grep` / `bash` / `webfetch` / `todowrite` が承認待ちなしで実行されます。MCP の bearer credential は token_v2 とは別に生成・保存します。Notion トークンやホストのモデル API キーを worker の環境には渡しません。

認証、ファイルツールのパスチェック、`external_directory` / `task` / `question` の拒否は維持します。ただし **シェルは OS のファイルシステム隔離ではありません**。全許可の bash は OS ユーザー権限で動きます。信頼できるプロジェクト、または専用コンテナ／VM で利用してください。

単体 CLI (`npm start` / `npm run start:http`) の従来の承認モードは変更しません。プログラムから toolbox を import する場合は `opencode-mcp-bridge/toolbox` を使用します。ルート export はプラグインです。

## 会話・停止・制限

- OpenCode セッションと Notion 会話を対応づけ、**新しいユーザー入力だけ**を送信します。全履歴の重複送信はしません。
- 完了済みの会話は再起動後も継続します。同じ message の再試行は保存済み返答を返し、編集を再実行しません。
- タイトル・要約・compaction 用のリクエストはローカル処理。本会話には送りません。自動 compaction は無効です。
- 一つのプロジェクトで進行できるターンは一つ。他セッションからの同時送信は明示的に拒否します。
- 停止時は Notion 中断を試行し、専用 worker の未完了ジョブをキャンセルします。通信障害時は Notion 側でも確認してください。
- 送信後に応答が不明になった message は自動再送しません。Notion 側を確認して、新しいメッセージまたは新規チャットを開始します。
- 状態は既定で `~/.local/state/opencode-notion`。会話の返答も含みます。ディレクトリ 0700 / ファイル 0600 とし、アカウント・ワークスペース・プロジェクトを分離します。
- 強制終了でロックが残った場合は、該当 OpenCode が動作していないことを確認し、エラーに示された lock だけを削除します。会話状態は消さないでください。
- **一つの公開 URL は一つのプロジェクト／起動専用**です。別ウィンドウ・worktree・別クライアントで共有しないでください。複数プロジェクトには別 URL とポートを用意します。停止は専用 worker の全ジョブが対象です。
- テキスト入力のみ。添付は黙って捨てず未対応エラーにします。
- 公開テキストを標準 SSE で逐次表示し、待機中は heartbeat を送ります。途中の書き直しは確定時に整合させます。表示されるツールは、この起動に紐づいた専用 MCP の native ジョブです。
- Notion 全会話の同期・取り込み、quota 回避のワークスペース自動作成／ローテーション、keep-awake、自動 continue は行いません。

## オプション

プラグイン指定を `["file:///.../dist/plugin.js", {"publicUrl":"https://example.com/mcp","accountFile":"/path/account.json","port":8787}]` の tuple にすることもできます。

| オプション | 環境変数 | 既定値 |
| --- | --- | --- |
| publicUrl | OPENCODE_NOTION_MCP_URL | 必須 |
| accountFile | NOTION_ACCOUNT_FILE | なし |
| spaceId | NOTION_SPACE_ID | file / アカウントから解決 |
| model | NOTION_DEFAULT_MODEL | default |
| stateDir | OPENCODE_NOTION_STATE_DIR | ~/.local/state/opencode-notion |
| runtimeDir | OPENCODE_MCP_RUNTIME_DIR | stateDir/runtime/1.18.29 |
| bun | OPENCODE_MCP_BUN | platform optional dependency |
| port | OPENCODE_MCP_PORT | 8787 |
| autoSetup | なし | true |
| includeUnlistedModels | なし | false（通常非表示のカタログ項目も一覧に含める） |

state/runtime は編集対象プロジェクトの外に置きます。bind は 127.0.0.1 固定です。

## 検証

```sh
npm run build
npm run setup:native
npm run typecheck:native
npm test
npm run test:opencode
npm run test:opencode:live
npm run test:opencode:usage
npm run test:package
npm audit --omit=dev
```

`test:opencode` は未改変の固定 OpenCode 本体で plugin loader / provider / assistant イベント／再起動後の会話継続を確認します。TUI のピクセル比較ではありません。`test:package` は tarball を `--ignore-scripts --omit=dev` で新規インストールして、Bun と native runtime の自動取得・起動を検証します。

`test:opencode:live` はモデル切替・途中テキスト・実 native 操作のカード・最終使用量を同時に検証し、`test:opencode:usage` は標準サイドバーが参照するカウンターと未取得時の挙動を確認します。Linux の実 OpenCode ホストを使用し、macOS の画面操作や TUI ピクセル比較は未検証です。

通常のテストは Notion の応答を模擬し、実アカウントや接続を変更しません。手動 live 検証の結果は [validation.md](validation.md) を参照してください。Cookie、会話識別子、接続 credential はリポジトリに含めません。

## Attachments and reasoning effort

OpenCode file attachments are forwarded to Notion AI through its transcript upload flow. Images, PDFs, and other inline files supported by OpenCode are accepted up to Notion's configured attachment limit. Remote URLs are not fetched by the adapter.

Models that expose Notion reasoning controls publish matching OpenCode variants. Use OpenCode's model variant selector to choose `none`, `low`, `medium`, `high`, `xhigh`, or `max` where supported; the selected value is sent as Notion's `reasoningEffort`.

# 安装 Akasha

给 Agent 的安装步骤。只做安装，不读写页面、不改无关配置。默认全局安装到你当前所在的宿主，用户另有要求时
照用户说的做。

## 1. 安装 Skill

```bash
npx -y skills@latest add https://github.com/chaterm/Akasha.git#beta \
  --skill akasha-query --skill akasha-pages --skill akasha-weekly-report \
  --agent <宿主> --global --copy --yes
```

`<宿主>` 填 `skills` CLI 能识别的宿主名，`claude-code`、`codex`、`cursor`、`opencode` 已验证可用。
其他宿主先按 CLI 的 `--agent` 列表填；CLI 不支持当前宿主时，改用下面的离线包安装。

没有 Node.js 22.20 以上，或宿主不在 CLI 支持范围内时，下载离线包，原样解压到宿主的全局 Skill
目录：

```bash
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/akasha-skills.zip" \
  https://raw.githubusercontent.com/chaterm/Akasha/beta/akasha-plugin/dist/akasha-skills.zip
unzip -o "$tmp/akasha-skills.zip" -d <Skill 目录>
rm -rf "$tmp"
```

| 宿主 | Skill 目录 |
| --- | --- |
| `claude-code` | `~/.claude/skills/` |
| `codex` | `~/.agents/skills/` |
| `cursor` | `~/.cursor/skills/` |
| `opencode` | `~/.config/opencode/skills/` |
| 其他宿主 | 自行判断：按该宿主存放全局 Skill 的目录放置，不确定时查其文档或 `skills` CLI 的 `--agent` 列表 |

Windows 没有 `unzip` 时用 PowerShell 的 `Invoke-WebRequest` 和 `Expand-Archive`。

## 2. 接入 MCP

向用户要 Akasha 部署地址，**不要索取 API Key**，Key 由用户自己填。

- Claude Code：把下面的命令发给用户，让用户替换 `<个人-key>` 后以 `!` 开头运行。

  ```bash
  claude mcp add --scope user --transport http akasha \
    "https://<部署地址>/mcp" \
    --header "Authorization: Bearer <个人-key>"
  ```

- Codex：把下面的配置写入 `~/.codex/config.toml`，Key 保留占位符，让用户自己替换。

  ```toml
  [mcp_servers.akasha]
  url = "https://<部署地址>/mcp"
  http_headers = { Authorization = "Bearer <个人-key>" }
  ```

- 其他宿主：按其 MCP 文档注册同样的 HTTP server 和请求头。

## 3. 验证

让用户重开会话，问「我们公司的报销制度是什么」，应当调用 `query_knowledge` 并返回带来源的答案。

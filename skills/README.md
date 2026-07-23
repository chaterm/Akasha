# Akasha Agent Skill

Akasha Agent Skill 可让 Agent 查询 Wiki 知识，以及在个人空间中创建、读取和更新 Page。

## 安装

需要本机已安装 Node.js。执行以下命令，从 GitHub 全局安装 Akasha Skill：

```bash
npx skills add chaterm/Akasha \
  --skill akasha \
  --agent codex \
  --global \
  --yes
```

安装完成后，请新建一个 Codex 会话，以便 Codex 发现并加载 Skill。

如果需要安装到其他受支持的编码 Agent，可去掉 `--agent codex`，然后根据交互提示选择目标 Agent：

```bash
npx skills add chaterm/Akasha --skill akasha --global
```

## 首次认证

无需提前查找 Skill 的安装目录或执行认证命令。

在自己的本地终端执行 Agent 提供的命令，并在隐藏提示中输入 API Key。认证完成后告诉 Agent 继续原来的操作即可。

不要把 API Key 发送给 Agent，也不要放入命令参数、源代码、临时文件、日志或聊天消息中。Akasha 服务地址不是密钥；如果 Agent 不知道该地址，可以直接提供服务地址。

## 更新

更新全局安装的 Skill：

```bash
npx skills update -g
```

## Skill 内容

Akasha Skill 位于 [`akasha`](./akasha/) 目录，详细行为和权限约束请参阅 [`akasha/SKILL.md`](./akasha/SKILL.md)。

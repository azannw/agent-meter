# Agent Meter

A Windows tray app that shows how much of my Claude and Codex limits are left, how many tokens I've used, and what that would cost at API prices. One click on the tray icon and the panel slides up from the taskbar.

<p align="center"><img src="docs/panel.png" width="400" alt="The Agent Meter panel: tokens and API cost for the last 30 days, usage limits for two Claude accounts and a Codex login, and daily cost"></p>

<p align="center"><sub>Sample data.</sub></p>

## What it shows

- **Limits** for each Claude account (5-hour, weekly and the Fable weekly limit) and for Codex, with when each one resets.
- **A warning** when you're on pace to run out before the reset, like "Weekly runs out in 13h 22m".
- **Tokens and API cost** for the last 30 days, plus today's cost.
- **Daily cost** for the last 30 days, Claude and Codex side by side.
- **The tray icon** is your weekly usage as a number. It turns red with a `!` when you hit a limit.

## How it works

Everything comes from files already on your machine. Agent Meter never reads login or credential files.

| What | Where it comes from |
| --- | --- |
| Claude tokens and cost | Claude Code transcripts in `%USERPROFILE%\.claude\projects`, plus any other `.claude-*` folder (one per account) |
| Codex tokens, cost and limits | Codex sessions in `%USERPROFILE%\.codex\sessions` |
| Claude limits | The cache written by [Claude Code Usage Monitor](https://github.com/CodeZeno/Claude-Code-Usage-Monitor), which needs to be installed and running |
| Prices | Anthropic's list prices are built in. Other models are looked up in [LiteLLM's public price list](https://github.com/BerriAI/litellm), at most once a day. That is the only network request it makes. |

## Run it

Windows 10 or 11 and Node 24.

```powershell
npm install
npm start
```

To add a Start Menu shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
```

"Start with Windows" is in the tray icon's right-click menu.

## Tests

```powershell
npm test          # unit tests
npm run test:ui   # checks the panel's layout off-screen
```

No build step, and no dependencies besides Electron.

# Team QA for Claude Code

Team QA runs QA on your app the way a small QA team would. It plans the testing, shows you the plan, the roles, the models and a cost estimate, and waits for your approval. Then it runs separate agents for each role (one drives the browser through Dragon, one reviews the code), checks every verdict against evidence, and ends with a GO or NO_GO you can trace back to screenshots, network logs and recordings.

This is the Claude Code plugin of Team QA 1.17.0. It holds the signed suite: Team QA, QA GUI and QA Code. Team QA is free to use for now, with no licence needed.

## Install

In Claude Code:

```text
/plugin marketplace add agentpro-tech/team-qa-releases
/plugin install team-qa@agentpro
```

Claude Code does not update plugins from other marketplaces on its own until you allow it: open `/plugin`, go to **Marketplaces**, pick **agentpro** and choose **Enable auto-update**. Otherwise run `/plugin update team-qa@agentpro` when a new version is out.

Then ask Claude to run `teamqa doctor`. It checks macOS, Node.js, QA GUI, QA Code, the Dragon runtime and the Dragon Browser extension, one item at a time, and names the fix for the first thing that is missing.

## What you need

- A Mac (macOS) and Node.js 20 or later.
- Google Chrome with the Dragon Browser extension from the Chrome Web Store.
- The Dragon runtime. If the doctor reports it missing, it prints the command that installs the signed runtime of this release.
- An app to test, and test accounts for it. Team QA reports defects; it does not change your code.

## What the plugin contains

- `skills/team-qa`, `skills/qa-gui`, `skills/qa-code`: the signed packages, file for file as the suite installer would install them. Before Team QA uses QA GUI or QA Code it checks their publisher signature and every file digest.
- `bin/teamqa`: the `teamqa` command, on the PATH of the commands Claude runs.
- `hooks/hooks.json`: hooks on Bash and MCP tool calls, Stop and SubagentStop. They act only for a session that `teamqa continuation register` bound to a Team QA run (keeping the run going, admitting Dragon calls and board writes). For every other session they answer `{}` at once: they read the hook input and one registry folder (`~/.agentpro/teamqa/continuation`), write nothing and use no network.

## What it runs, sends and fetches

- It runs the Node.js scripts of the three skills on your Mac, and the AI CLI workers (Claude Code or Codex) that you approve in the roster.
- Prompts and outputs go only to the AI provider you use, under your own account. Team QA sends nothing to Agent Pro and has no telemetry.
- Screenshots, logs, recordings, boards and reports stay in the run folder on your Mac. Test-account passwords never appear in the board, the report, the RTM or the plan.
- It downloads only when you or Claude run `teamqa dragon install --from <URL>`: the signed Dragon runtime from this project's release page, checked against Dragon's signing key before any of it runs.

## Help

Open an issue at https://github.com/agentpro-tech/team-qa-releases/issues and attach the file from `teamqa doctor --bundle diagnostics.json` after reading it (tokens, passwords, e-mail addresses and your home path are removed).

Terms of use and a privacy policy will be published at https://github.com/agentpro-tech/team-qa-releases.

#!/bin/sh
# Hook command of the Team QA plugin (BA plugin C4): runs scripts/hooks/plugin-gate.mjs with Node.js. Node is looked
# for where `teamqa continuation register` last ran it (the registry's .node), then on PATH, then at the Homebrew and
# installer locations: Claude Code started from the Dock may not have the PATH of a shell with nvm, volta or fnm.
# Without any Node.js, a session no run is registered to gets {}; a registered one gets a refusal, never a pass.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
registry="$HOME/.agentpro/teamqa/continuation"
input=$(cat)
recorded=""; [ -f "$registry/.node" ] && recorded=$(head -n 1 "$registry/.node")
for n in "$recorded" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then
    printf '%s' "$input" | "$n" "$here/../hooks/plugin-gate.mjs"
    exit $?
  fi
done
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)
if [ -n "$sid" ] && [ -f "$registry/$sid.json" ]; then
  case "$input" in
    *'"PreToolUse"'*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"TEAMQA_HOOK_NODE_MISSING"}}';;
    *) echo '{"systemMessage":"QA NOT COMPLETE: hook error TEAMQA_HOOK_NODE_MISSING (the Team QA hook found no Node.js)"}';;
  esac
  exit 0
fi
echo '{}'

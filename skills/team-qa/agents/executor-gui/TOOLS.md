# Tool wiring

```yaml
fs.read:
  cowork: Read
  codex: read_file
fs.write:
  cowork: Write
  codex: apply_patch
mcp.client:
  cowork: dragon_rpc
  codex: dragon_rpc
vision.inspect:
  cowork: captureTab
  codex: capture_tab
```

Invoke qa-gui only through the commands and schema declared in `roles.json`.

Evidence (QA GUI evidence policy v1): the executor writes no files; `teamqa web collect` makes the light, bound evidence from its
stream (references/executor-evidence.md). Screenshots stay on the tab whose page identity was read, with `dom` and `domHash`
in the result. A behavioral recording starts with `startRecording {…,tabId,quality:50,maxWidth:960,maxHeight:960}` on that tab
before the first trusted action and ends with `stopRecording` → `assembleRecording` after the last one.

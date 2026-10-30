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

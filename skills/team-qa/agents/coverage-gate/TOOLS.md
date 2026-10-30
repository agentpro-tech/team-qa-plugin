# Tool wiring

```yaml
fs.read:
  cowork: Read
  codex: read_file
  gemini: read_file
fs.write:
  cowork: Write
  codex: apply_patch
  gemini: write_file
shell.exec:
  cowork: Bash
  codex: exec_command
  gemini: run_shell_command
```

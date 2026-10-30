# TOOLS — what this agent can use

<!-- Declare WIRING here, not implementations. The real tool functions live in your
     app code; this file maps the agent's logical capabilities to runtime bindings.
     `scroll build` reads this to wire each runtime correctly. -->

## Capabilities (logical — must match IDENTITY.md)
- `web.search` — find sources on the open web
- `fs.read` — read files the user attached

## Tool bindings (per runtime)
```yaml
web.search:
  cowork: WebSearch              # built-in
  codex:  web_search             # OpenAI tool
  gemini: google_search          # Gemini tool
fs.read:
  cowork: Read
  codex:  read_file
  gemini: read_file
```

## Caching note
Tool definitions are large and stable — `scroll build` places them in the cached
prefix automatically. Don't move them; it breaks cache hits.

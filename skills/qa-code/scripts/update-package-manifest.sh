#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
node "$ROOT/scripts/package-tool.mjs" manifest --root "$ROOT" --out "$ROOT/package-manifest.json"
node "$ROOT/scripts/package-tool.mjs" verify --root "$ROOT" --manifest "$ROOT/package-manifest.json"

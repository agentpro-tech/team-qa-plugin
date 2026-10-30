#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]
def value(flag):
    return args[args.index(flag) + 1]

if os.environ.get("TEAMQA_TEST_CALL_LOG"):
    with open(os.environ["TEAMQA_TEST_CALL_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"tool": "doc-colab", "args": args}) + "\n")
with open(value("--data"), encoding="utf-8") as source:
    board = json.load(source)
payload = json.dumps({"qaBoard": board}).replace("</", "<\\/")
with open(value("--out"), "w", encoding="utf-8") as output:
    output.write("<html><!-- DOC_DATA_START --><script id=\"doc-data\">window.DOC_DATA = " + payload + ";</script><!-- DOC_DATA_END --></html>")
print(json.dumps({"ok": True, "out": value("--out")}))

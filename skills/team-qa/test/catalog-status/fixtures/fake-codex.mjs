#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY) process.exit(65);
if(!process.env.HOME||!process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR) process.exit(66);
if(process.env.CATALOG_TEST_CALL_LOG) appendFileSync(process.env.CATALOG_TEST_CALL_LOG,JSON.stringify({args,home:process.env.HOME,config:process.env.CODEX_HOME})+'\n');
if(args.length===1&&args[0]==='--version') console.log('codex-cli 0.151.7');
else if(args.length===1&&args[0]==='--help') console.log('Codex CLI help: --model --config');
else if(args.length===2&&args[0]==='exec'&&args[1]==='--help') console.log('exec help: -m --model -c --config --json');
else process.exit(64);

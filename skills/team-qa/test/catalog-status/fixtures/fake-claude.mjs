#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY) process.exit(65);
if(!process.env.HOME||!process.env.CLAUDE_CONFIG_DIR||process.env.CODEX_HOME) process.exit(66);
if(process.env.CATALOG_TEST_CALL_LOG) appendFileSync(process.env.CATALOG_TEST_CALL_LOG,JSON.stringify({args,home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR})+'\n');
if(args.length===1&&args[0]==='--version') console.log('2.1.207 (Claude Code)');
else if(args.length===1&&args[0]==='--help') console.log('Claude Code help: --model --effort');
else process.exit(64);

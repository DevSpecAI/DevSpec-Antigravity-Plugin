---
name: autopilot-log
description: "View the local autopilot execution history (~/.devspec/execution-history.jsonl) written by autopilot and work runs — a local, offline log distinct from the API-backed history. Use when asked for the local run log."
---

Read and display the **local** execution history written by `/autopilot:process` and `/devspec:work`. This is distinct from `/autopilot:history`, which queries the DevSpec API.

JSONL schema: each run writes a `running` start line and a terminal (`success`/`failure`) line sharing the same `id`; the node command below merges them by `id`.

## Arguments

Parse the user's input for optional flags:

- `--status <success|failure|timeout|skipped|running>` — show only records with this status
- `--limit <N>` — show at most N records (default: 20)

Accept any order; ignore unknown flags.

## Steps

1. **Read and parse the history file** — run a single node command that does all filtering and formatting so the output is deterministic. Pass the `--status` value (or empty string) and `--limit` value as `process.argv[1]` and `process.argv[2]`:

   ```
   node -e "const fs=require('fs'),path=require('path'),os=require('os'); const file=path.join(os.homedir(),'.devspec','execution-history.jsonl'); if(!fs.existsSync(file)){console.log('No local history yet. Run /autopilot:process or /devspec:work to populate it.');process.exit(0);} const statusFilter=process.argv[1]||''; const limit=parseInt(process.argv[2])||20; const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean); const merged=new Map(); for(const l of lines){try{const r=JSON.parse(l); merged.set(r.id,Object.assign({},merged.get(r.id)||{},r));}catch{}} let records=Array.from(merged.values()).sort((a,b)=>new Date(b.startedAt||0)-new Date(a.startedAt||0)); if(statusFilter)records=records.filter(r=>r.status===statusFilter); records=records.slice(0,limit); if(records.length===0){console.log('No local records match the given filters.');process.exit(0);} const icon={running:'\u25B6',success:'\u2713',failure:'\u2717',timeout:'\u23F1',skipped:'\u2298'}; for(const r of records){const started=r.startedAt?r.startedAt.slice(0,19).replace('T',' '):'unknown'; const dur=r.duration!=null?(r.duration<1000?r.duration+'ms':r.duration<60000?Math.round(r.duration/1000)+'s':Math.round(r.duration/60000)+'m'):(r.status==='running'?'running':'-'); const sha=r.commitSha?r.commitSha.slice(0,8):'-'; const branch=r.agentBranch||'-'; const title=(r.actionItemTitle||r.actionItemId||'(unknown)').slice(0,60); console.log((icon[r.status]||'?')+' '+r.status.padEnd(8)+' '+started+' '+dur.padStart(6)+' '+sha+' '+branch+' \u00b7 '+title);} console.log(''); console.log('  \u2501\u2501 '+records.length+' shown \u00b7 file: '+file);" '{status}' '{limit}'
   ```

2. **Shell safety:** Wrap the `--status` and `--limit` values in single quotes. The status value must match `^[a-z]*$` (Rule 5-adjacent: if it contains anything else, print `Invalid --status value` and stop — do not run the command). The limit must match `^[0-9]*$`; if not, print `Invalid --limit value` and stop.

3. **Display the output** from node directly. Do not add filler text before or after.

## Example output

```
▶ running  2026-04-16 20:03:55 running 3ec74290 work/action-item-e17a658b · Add structural shell injection prevention…
✓ success  2026-04-16 19:45:02     12s a1b2c3d4 autopilot/action-item-b3f15060 · Add local JSONL execution history…
✗ failure  2026-04-16 18:22:11      3s -        autopilot/action-item-c4d5e6f7 · Fix mobile login — Merge conflict
  ━━ 3 shown · file: ~/.devspec/execution-history.jsonl
```

## Rules

- Do NOT query the DevSpec API — this is a local-only command
- Do NOT output filler text around the history table
- If the file does not exist yet, say so once and exit cleanly (do not error)
- Do NOT re-run the node command if it completes successfully (avoid duplicate output)
- Sanitize flag values before passing them into the node command (validate `--status` against `^[a-z]*$` and `--limit` against `^[0-9]*$`, as above)

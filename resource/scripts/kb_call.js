const { spawnSync } = require('child_process');
const fs = require('fs');
const skill = 'C:/Users/周国玮/.workbuddy/skills/ima-skill/ima_api.cjs';
const api = process.argv[2];
const bodyFile = process.argv[3];
const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8').trim() : '{}';
const r = spawnSync(process.execPath, [skill, api, body], { encoding: 'utf8' });
process.stdout.write('STDOUT:\n' + (r.stdout || '') + '\nSTDERR:\n' + (r.stderr || '') + '\nEXIT:' + r.status);

import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
for(const f of ['dist/index.html','dist/app.js','dist/physics.js','dist/state.js','dist/styles.css']){
 if(!fs.existsSync(f))throw new Error(`missing ${f}`);
 if(f.endsWith('.js'))execFileSync(process.execPath,['--check',f]);
}
const h=fs.readFileSync('dist/index.html','utf8');
for(const r of ['./app.js','./styles.css'])if(!h.includes(r))throw new Error(`index missing ${r}`);
console.log('Static package and JavaScript syntax verified.');

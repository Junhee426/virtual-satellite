import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const files=['dist/index.html','dist/app.js','dist/physics.js','dist/state.js','dist/worker.js','dist/styles.css'];
for(const f of files){
 if(!fs.existsSync(f))throw new Error(`missing ${f}`);
 if(f.endsWith('.js'))execFileSync(process.execPath,['--check',f]);
}
const h=fs.readFileSync('dist/index.html','utf8');
for(const r of ['./app.js','./styles.css'])if(!h.includes(r))throw new Error(`index missing ${r}`);

// Every cache-busting ?v= must match package.json, or a browser can mix old and new modules.
const {version}=JSON.parse(fs.readFileSync('package.json','utf8'));
for(const f of ['dist/index.html','dist/app.js','dist/worker.js']){
 const src=fs.readFileSync(f,'utf8');
 const tags=[...src.matchAll(/\.(?:js|css)\?v=([\w.-]+)/g)].map(m=>m[1]);
 if(!tags.length)throw new Error(`${f} has no versioned references`);
 for(const tag of tags)if(tag!==version)throw new Error(`${f} references ?v=${tag}, expected ${version}`);
}
for(const f of ['dist/app.js','dist/worker.js']){
 const bare=fs.readFileSync(f,'utf8').match(/from '\.\/\w+\.js'/);
 if(bare)throw new Error(`${f} imports without a version: ${bare[0]}`);
}
console.log(`Static package, JavaScript syntax and asset versions (${version}) verified.`);

import fs from 'node:fs';
for(const f of ['dist/index.html','dist/app.js','dist/physics.js','dist/styles.css']) if(!fs.existsSync(f)) throw new Error(`missing ${f}`);
const h=fs.readFileSync('dist/index.html','utf8'); for(const r of ['./app.js','./styles.css']) if(!h.includes(r)) throw new Error(`index missing ${r}`);
console.log('Static package verified.');

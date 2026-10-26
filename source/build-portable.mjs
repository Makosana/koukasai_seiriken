import {mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
// SEIRIKEN_OUTPUT lets the build run from a local copy of source/ (e.g. when the project sits on a network drive).
const root=dirname(fileURLToPath(import.meta.url));
const destination=process.env.SEIRIKEN_OUTPUT?resolve(process.env.SEIRIKEN_OUTPUT):resolve(root,'..');
mkdirSync(join(destination,'app/lib'),{recursive:true});
for(const name of ['server.mjs','storage.mjs','control.mjs','schema.sql'])copyFileSync(join(root,'backend',name),join(destination,'app',name));
for(const name of readdirSync(join(root,'backend/lib')))copyFileSync(join(root,'backend/lib',name),join(destination,'app/lib',name));
await build({configFile:join(root,'vite.config.mjs')});
copyFileSync(join(root,'frontend/favicon.svg'),join(destination,'app/public/favicon.svg'));
console.log('Portable application built: '+destination);

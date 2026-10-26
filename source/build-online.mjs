import {copyFileSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build,loadEnv} from 'vite';
const root=dirname(fileURLToPath(import.meta.url));
const destination=process.env.SEIRIKEN_OUTPUT?resolve(process.env.SEIRIKEN_OUTPUT):resolve(root,'..');
const env=loadEnv('online',root,'VITE_');
if(!env.VITE_SUPABASE_URL||!env.VITE_SUPABASE_ANON_KEY){
  console.warn(existsSync(join(root,'.env.online'))
    ?'注意: source/.env.online に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を書いてください。'
    :'注意: source/.env.online がありません。.env.online.example をコピーして作ってください。');
  console.warn('このままビルドすると、画面に「接続先が設定されていません」と表示されます。');
}
await build({configFile:join(root,'vite.config.mjs'),mode:'online'});
const output=join(destination,'online');
copyFileSync(join(root,'frontend/favicon.svg'),join(output,'favicon.svg'));
writeFileSync(join(output,'.nojekyll'),'');
console.log('Online (Supabase) version built: '+output);

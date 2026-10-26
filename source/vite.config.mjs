import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const destination=process.env.SEIRIKEN_OUTPUT?resolve(process.env.SEIRIKEN_OUTPUT):resolve(root,'..');
// --mode online builds the Supabase version: a static site in ../online that works from any URL path.
const onlineHtml={name:'seiriken-online-html',transformIndexHtml:{order:'pre',handler:html=>html.replace('<script src="/runtime-config.js"></script>','').replace('href="/favicon.svg"','href="./favicon.svg"')}};
export default defineConfig(({mode})=>{
  const online=mode==='online';
  return {
    root,
    base:online?'./':'/',
    plugins:online?[react(),onlineHtml]:[react()],
    resolve:{alias:{'@':resolve(root,'frontend')}},
    css:{postcss:{plugins:[tailwindcss()]}},
    build:{outDir:resolve(destination,online?'online':'app/public'),emptyOutDir:true,sourcemap:false}
  };
});

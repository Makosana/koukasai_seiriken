// オンライン版（online フォルダー）をこのPCで試すための簡易サーバー。データはSupabaseに保存されます。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=dirname(fileURLToPath(import.meta.url));
const directory=resolve(process.env.SEIRIKEN_ONLINE_DIR??join(root,'..','online'));
const port=Number(process.env.SEIRIKEN_PREVIEW_PORT??8767);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};

if(!existsSync(join(directory,'index.html'))){
  console.error('online フォルダーにオンライン版がありません。supabase\\README.md の手順でビルドしてください。');
  process.exit(1);
}

const server=createServer(async(req,res)=>{
  let path;
  try{path=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname);}catch{res.writeHead(400).end();return;}
  if(path.endsWith('/'))path+='index.html';
  const file=resolve(directory,'.'+path);
  if(file!==directory&&!file.startsWith(directory+sep)){res.writeHead(403).end();return;}
  try{
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}).end('見つかりません');}
});
server.on('error',error=>{
  console.error(error.code==='EADDRINUSE'?`ポート ${port} は使用中です。すでに開いている「オンライン版を試す」の画面を閉じてから、もう一度実行してください。`:error.message);
  process.exit(1);
});
server.listen(port,'127.0.0.1',()=>{
  const url=`http://127.0.0.1:${port}/`;
  console.log('紅華祭 整理券（オンライン版・試用）');
  console.log(`  来場者画面: ${url}`);
  console.log(`  運営画面  : ${url}#/admin`);
  console.log('このPCでの確認用です。来場者に配るURLは、公開先（GitHub Pagesなど）のURLを使ってください。');
  console.log('終了するときは、この画面を閉じてください。');
  if(!process.argv.includes('--no-browser'))spawn('cmd',['/c','start','',`${url}#/admin`],{detached:true,stdio:'ignore'}).unref();
});

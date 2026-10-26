import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dataDirectory=process.env.SEIRIKEN_DATA_DIR??join(root,'data');
try{
 const instance=JSON.parse(readFileSync(join(dataDirectory,'running-instance.json'),'utf8'));
 if(instance.app!=='koukasai-seiriken-portable-v1'||!Number.isInteger(instance.port)||instance.port<1024||instance.port>65535)throw new Error('起動情報が正しくありません。');
 const health=await fetch(`http://127.0.0.1:${instance.port}/healthz`,{signal:AbortSignal.timeout(3000)});
 const info=await health.json();
 if(info.app!==instance.app||info.folderHash!==instance.folderHash)throw new Error('別のフォルダーで起動している整理券アプリです。');
 const r=await fetch(`http://127.0.0.1:${instance.port}/_local/stop`,{method:'POST',headers:{'X-Seiriken-Stop':instance.stopToken},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error('停止要求が受け付けられませんでした。');
 console.log('終了処理を開始しました。バックアップが完了すると、起動中の黒い画面が閉じます。');
}catch(e){
 if(e.code==='ENOENT'||e.cause?.code==='ECONNREFUSED')console.log('このフォルダーの整理券アプリは起動していません。');
 else{console.error('停止できませんでした: '+e.message);process.exitCode=1;}
}

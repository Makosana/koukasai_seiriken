import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync,existsSync,statSync,appendFileSync} from 'node:fs';
import {join,resolve,extname,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {spawn} from 'node:child_process';
import {openStorage} from './storage.mjs';
import {SeirikenError,adminOperation,adminState,cancelByStaff,cancelByVisitor,ensureSettings,findRequest,issueTicket,listTickets,lookupTickets,publicState,ticketsCsv} from './lib/seiriken-service.mjs';

const APP_ID='koukasai-seiriken-portable-v1';
export const DEFAULT_PORT=8766;
export function timestamp(now=new Date()){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const n=Object.fromEntries(p.map(x=>[x.type,x.value]));
  return `${n.year}${n.month}${n.day}_${n.hour}${n.minute}${n.second}_${String(now.getMilliseconds()).padStart(3,'0')}`;
}
function same(a,b){const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);}
function loopback(address){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);}
function browser(url){
  if(process.env.SEIRIKEN_NO_BROWSER==='1')return;
  if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,stdio:'ignore',windowsHide:true}).unref();
  else if(process.platform==='darwin')spawn('open',[url],{detached:true,stdio:'ignore'}).unref();
  else console.log(`ブラウザーで開いてください: ${url}`);
}
const headerBase={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
function send(res,status,body,headers={}){res.writeHead(status,{...headerBase,...headers});res.end(body);}
function json(res,status,body,headers={}){send(res,status,JSON.stringify(body),{'Content-Type':'application/json; charset=utf-8',...headers});}
async function readBody(req,max=16384){let bytes=0;const blocks=[];for await(const block of req){bytes+=block.length;if(bytes>max)throw new SeirikenError('送信内容が大きすぎます。',413);blocks.push(block);}return Buffer.concat(blocks).toString('utf8');}
async function readJson(req){
  if(req.headers['x-seiriken-request']!=='1'||!req.headers['content-type']?.startsWith('application/json'))throw new SeirikenError('送信内容を確認できません。',403);
  const text=await readBody(req);try{return JSON.parse(text);}catch{throw new SeirikenError('入力内容を読み取れません。');}
}
function atomicWrite(path,contents){const tmp=path+'.part';writeFileSync(tmp,contents,{mode:0o600});renameSync(tmp,path);}
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.woff2':'font/woff2'};
function windowLimiter(limit,windowMs){
  const slots=new Map();
  return key=>{
    const now=Date.now();
    if(slots.size>5000)for(const [k,v] of slots)if(v.until<=now)slots.delete(k);
    let slot=slots.get(key);
    if(!slot||slot.until<=now){slot={count:0,until:now+windowMs};slots.set(key,slot);}
    slot.count++;
    return slot.count<=limit;
  };
}

export async function startApplication(options={}){
 const here=dirname(fileURLToPath(import.meta.url));
 const root=resolve(options.root??join(here,'..'));
 const dataDirectory=resolve(options.dataDirectory??join(root,'data'));
 const backupDirectory=resolve(options.backupDirectory??join(root,'backups'));
 const exportDirectory=resolve(options.exportDirectory??join(root,'exports'));
 const logDirectory=resolve(options.logDirectory??join(root,'logs'));
 const schemaPath=resolve(options.schemaPath??join(here,'schema.sql'));
 const publicDirectory=resolve(options.publicDirectory??join(here,'public'));
 const clock=options.now??(()=>new Date());
 const port=options.port??DEFAULT_PORT,lan=options.lan??false,host=lan?'0.0.0.0':'127.0.0.1';
 const folderHash=createHash('sha256').update(dataDirectory.toLowerCase()).digest('hex');
 const stopToken=randomBytes(32).toString('hex');
 const instancePath=join(dataDirectory,'running-instance.json');
 for(const dir of [dataDirectory,backupDirectory,exportDirectory,logDirectory])mkdirSync(dir,{recursive:true});
 const log=(level,message)=>{const line=`${new Date().toISOString()} [${level}] ${String(message).replace(/[\r\n]/g,' ')}\n`;try{appendFileSync(join(logDirectory,'app.log'),line);}catch{}if(level==='ERROR')console.error(message);};
 const localAddresses=new Set(['127.0.0.1','localhost','[::1]']);
 const lanAddresses=[];
 if(lan){try{for(const addresses of Object.values(networkInterfaces()))for(const a of addresses??[])if(a.family==='IPv4'&&!a.internal){localAddresses.add(a.address);lanAddresses.push(a.address);}}catch{log('INFO','Network interface enumeration unavailable; use the PC IPv4 address for LAN access.');}}
 let storage,closing=false,closePromise=null,backupPromise=null,lastBackup=null,backupError=null,mutationCount=0,backupCounter=0,timer;
 const loginLimit=windowLimiter(10,600000),issueLimit=windowLimiter(options.issueRateLimit??30,60000);
 async function makeBackup(reason){
   if(!storage)return;
   if(backupPromise)return backupPromise;
   const pendingAtStart=mutationCount;
   backupPromise=(async()=>{
     const filename=`seiriken_${timestamp()}_${++backupCounter}_${reason}.sqlite3`;
     try{await storage.snapshot(join(backupDirectory,filename));lastBackup=new Date().toISOString();backupError=null;mutationCount=Math.max(0,mutationCount-pendingAtStart);return filename;}
     catch(e){backupError='自動バックアップを作成できません。PCの空き容量と保存先を確認してください。';log('ERROR',`Backup failed: ${e.message}`);throw e;}
     finally{backupPromise=null;}
   })();
   return backupPromise;
 }
 function changed(){mutationCount++;if(mutationCount>=20)makeBackup('auto').catch(()=>{});}
 const staffToken=()=>createHmac('sha256',storage.installationSecret).update('staff-session-v1').digest('hex');
 function staffAuthenticated(req){
   if(loopback(req.socket.remoteAddress))return true;
   const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('seiriken_staff='))?.slice(15);
   return !!cookie&&same(cookie,staffToken());
 }
 function validateOrigin(req,origin){if(req.headers.origin&&req.headers.origin!==origin)throw new SeirikenError('送信元を確認できません。',403);}

 async function handlePublic(req,res,url){
   const path=url.pathname.slice('/api/public/'.length);
   if(path==='state'&&req.method==='GET'){json(res,200,publicState(storage.sqlite,clock()));return;}
   if(req.method!=='POST')throw new SeirikenError('この操作は利用できません。',405);
   const body=await readJson(req);
   if(path==='issue'){
     if(!issueLimit(req.socket.remoteAddress))throw new SeirikenError('操作が多すぎます。1分ほど待ってからやり直してください。',429,'throttled');
     const result=issueTicket(storage,body,clock());if(!result.replayed)changed();json(res,200,result);return;
   }
   if(path==='tickets'){json(res,200,lookupTickets(storage.sqlite,body,clock()));return;}
   if(path==='request'){json(res,200,findRequest(storage.sqlite,body,clock()));return;}
   if(path==='cancel'){const result=cancelByVisitor(storage,body,clock());if(!result.replayed)changed();json(res,200,result);return;}
   throw new SeirikenError('この操作は利用できません。',404);
 }

 async function handleAdmin(req,res,url){
   const path=url.pathname.slice('/api/admin/'.length);
   if(path==='login'&&req.method==='POST'){
     const body=await readJson(req);
     if(!loginLimit(req.socket.remoteAddress))throw new SeirikenError('スタッフコードの確認回数が多いため、10分後にやり直してください。',429,'throttled');
     if(!same(body?.code,storage.staffCode))throw new SeirikenError('スタッフコードが一致しません。PCの画面を確認してください。',403,'bad_code');
     json(res,200,{ok:true},{'Set-Cookie':`seiriken_staff=${staffToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`});return;
   }
   if(!staffAuthenticated(req))throw new SeirikenError('運営画面を使うにはスタッフコードを入力してください。',401,'login');
   const isLocal=loopback(req.socket.remoteAddress);
   if(path==='state'&&req.method==='GET'){
     json(res,200,{...adminState(storage.sqlite,clock()),server:{lan,lanUrls:lanAddresses.map(a=>`http://${a}:${actualPort}/`),port:actualPort,isLocal,staffCode:isLocal?storage.staffCode:null,lastBackup,backupError,databasePath:isLocal?storage.databasePath:null}});return;
   }
   if(path==='tickets'&&req.method==='GET'){json(res,200,listTickets(storage.sqlite,Object.fromEntries(url.searchParams),clock()));return;}
   if(path==='csv'&&req.method==='GET'){
     const filename=`seiriken-tickets-${timestamp()}.csv`,contents=ticketsCsv(storage.sqlite);
     atomicWrite(join(exportDirectory,filename),contents);
     send(res,200,contents,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`});return;
   }
   if(req.method!=='POST')throw new SeirikenError('この操作は利用できません。',405);
   const body=await readJson(req);
   if(path==='operation'){json(res,200,adminOperation(storage,body,clock()));changed();return;}
   if(path==='cancel'){const result=cancelByStaff(storage,body,clock());if(!result.replayed)changed();json(res,200,result);return;}
   if(path==='backup'){const filename=await makeBackup('manual');json(res,200,{filename});return;}
   throw new SeirikenError('この操作は利用できません。',404);
 }

 const server=createServer(async(req,res)=>{
   try{
     const hostHeader=req.headers.host;
     if(!hostHeader)throw new SeirikenError('接続先を確認できません。',400);
     let url;try{url=new URL(req.url,`http://${hostHeader}`);}catch{throw new SeirikenError('URLが正しくありません。',400);}
     const socketAddress=req.socket.localAddress?.replace(/^::ffff:/,'');
     if((!localAddresses.has(url.hostname)&&!(lan&&url.hostname===socketAddress))||url.port!==String(server.address()?.port))throw new SeirikenError('この接続先は利用できません。',403);
     if(req.method==='OPTIONS'){send(res,405,'Method not allowed');return;}
     if(url.pathname==='/healthz'){
       if(!loopback(req.socket.remoteAddress)){json(res,403,{error:'この操作は受付PCからのみ利用できます。'});return;}
       json(res,200,{app:APP_ID,folderHash,ready:!!storage&&!closing,pid:process.pid});return;
     }
     if(url.pathname==='/_local/stop'){
       if(req.method!=='POST'||!loopback(req.socket.remoteAddress)||!same(req.headers['x-seiriken-stop'],stopToken))throw new SeirikenError('停止操作を確認できません。',403);
       json(res,200,{stopping:true},{'Connection':'close'});setImmediate(()=>close().catch(e=>log('ERROR',e.message)));return;
     }
     if(!storage||closing){json(res,503,{error:'整理券PCを準備中、または終了処理中です。少し待ってから画面を開き直してください。'});return;}
     validateOrigin(req,url.origin);
     if(url.pathname==='/runtime-config.js'){
       send(res,200,`window.SEIRIKEN_CONFIG=${JSON.stringify({databaseId:storage.installationId,portable:true,lan})};`,{'Content-Type':'text/javascript; charset=utf-8'});return;
     }
     if(url.pathname.startsWith('/api/public/')){await handlePublic(req,res,url);return;}
     if(url.pathname.startsWith('/api/admin/')){await handleAdmin(req,res,url);return;}
     if(url.pathname.startsWith('/api/'))throw new SeirikenError('この操作は利用できません。',404);
     if(!['GET','HEAD'].includes(req.method))throw new SeirikenError('この操作は利用できません。',405);
     let path;try{path=decodeURIComponent(url.pathname);}catch{throw new SeirikenError('URLが正しくありません。',400);}
     if(path.includes('\0')||path.includes('\\'))throw new SeirikenError('URLが正しくありません。',400);
     const localPath=resolve(publicDirectory,path==='/'?'index.html':'.'+path);
     if(!localPath.startsWith(publicDirectory+'/')&&!localPath.startsWith(publicDirectory+'\\'))throw new SeirikenError('ファイルが見つかりません。',404);
     const type=contentTypes[extname(localPath)];
     if(!type||!existsSync(localPath)||!statSync(localPath).isFile())throw new SeirikenError('ファイルが見つかりません。',404);
     send(res,200,req.method==='HEAD'?'':readFileSync(localPath),{'Content-Type':type,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
   }catch(e){
     if(e instanceof SeirikenError){json(res,e.status,{error:e.message,code:e.code});return;}
     if(e?.code==='ERR_SQLITE_ERROR'&&/UNIQUE|constraint/i.test(e.message)){json(res,409,{error:'同時に申し込みが集中しました。もう一度お試しください。',code:'conflict'});return;}
     log('ERROR',e.stack??e.message??String(e));json(res,503,{error:'整理券PCで処理を完了できませんでした。少し待ってからもう一度お試しください。',code:'server'});
   }
 });
 server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen({port,host,backlog:2048},()=>{server.removeListener('error',reject);resolveListen();});});
 const actualPort=server.address().port;
 try{
   storage=openStorage(dataDirectory,schemaPath);
   ensureSettings(storage.sqlite,clock());
   atomicWrite(instancePath,JSON.stringify({app:APP_ID,pid:process.pid,port:actualPort,folderHash,stopToken}));
   await makeBackup('startup').catch(()=>{});
   timer=setInterval(()=>{if(mutationCount>0)makeBackup('periodic').catch(()=>{});},300000);timer.unref();
 }catch(e){await new Promise(r=>server.close(r));throw e;}
 function close(){
   if(closePromise)return closePromise;
   closing=true;clearInterval(timer);
   closePromise=(async()=>{
     // Phones keep connections alive; give in-flight requests 2s, then drop the rest.
     await new Promise(r=>{server.close(r);server.closeIdleConnections();setTimeout(()=>server.closeAllConnections(),2000).unref();});
     try{if(backupPromise)await backupPromise.catch(()=>{});await makeBackup('shutdown').catch(()=>{});}finally{
       storage.close();
       try{const instance=JSON.parse(readFileSync(instancePath,'utf8'));if(same(instance.stopToken,stopToken))unlinkSync(instancePath);}catch{}
       log('INFO','Stopped safely');
     }
   })();
   return closePromise;
 }
 log('INFO',`Started ${APP_ID}, runtime ${process.version}, port ${actualPort}, lan ${lan}`);
 return {server,storage,port:actualPort,folderHash,stopToken,instancePath,close,makeBackup,url:`http://127.0.0.1:${actualPort}/`,lanUrls:lanAddresses.map(a=>`http://${a}:${actualPort}/`)};
}

export async function main(){
 const lan=process.argv.includes('--lan'),open=process.argv.includes('--open');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const port=Number(process.env.SEIRIKEN_PORT??DEFAULT_PORT);
 const dataDirectory=process.env.SEIRIKEN_DATA_DIR??join(root,'data');
 const folderHash=createHash('sha256').update(resolve(dataDirectory).toLowerCase()).digest('hex');
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('起動ポートが正しくありません。');
 try{
   const app=await startApplication({root,dataDirectory,port,lan});
   const adminUrl=app.url+'#/admin';
   console.log('\n紅華祭 整理券（インストール不要版）\n');
   console.log(`運営画面（このPC）: ${adminUrl}`);
   console.log(`データ保存先: ${app.storage.databasePath}`);
   console.log(`自動バックアップ: ${join(root,'backups')}`);
   if(lan){
     console.log('\n来場者のスマホは、PCと同じWi-Fiにつないでから以下のURLを開きます。');
     console.log('（運営画面の「掲示用QR」から、このURLのQRコードを印刷できます）');
     for(const u of app.lanUrls)console.log(`  ${u}`);
     if(!app.lanUrls.length)console.log(`  http://このPCのIPv4アドレス:${app.port}/ （IPv4は ipconfig で確認できます）`);
     console.log(`\n他のスタッフ端末で運営画面を開くときのスタッフコード: ${app.storage.staffCode}`);
     console.log('このコードは運営スタッフだけで共有してください。来場者には教えないでください。\n');
   }else{
     console.log('\nこの起動方法では、このPCからしか開けません（準備・確認用）。');
     console.log('来場者のスマホから使うときは「来場者受付用に起動.bat」で起動してください。\n');
   }
   console.log('終了するときは「停止.bat」を使うか、この画面で Ctrl+C を押してください。\n');
   if(open)browser(adminUrl);
   let stopping=false;const stop=()=>{if(stopping)return;stopping=true;app.close().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});};
   process.on('SIGINT',stop);process.on('SIGTERM',stop);
 }catch(e){
   if(e.code==='EADDRINUSE'){
     try{const r=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(3000)}),s=await r.json();if(s.app===APP_ID&&s.folderHash===folderHash){console.log('このフォルダーの整理券アプリは起動済みです。来場者受付用に切り替える場合は、先に「停止.bat」で停止してください。');if(open)browser(`http://127.0.0.1:${port}/#/admin`);return;}}catch{}
     throw new Error('同じポートが別のプログラム、または別フォルダーの整理券アプリで使用されています。起動中のアプリを確認してからやり直してください。');
   }
   throw e;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error('\n起動できませんでした。\n'+(e.stack??e.message));process.exitCode=1;});

import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID, randomBytes, randomInt } from 'node:crypto';

export function openStorage(dataDirectory, schemaPath) {
  mkdirSync(dataDirectory, {recursive:true});
  const databasePath=join(dataDirectory,'seiriken.sqlite3');
  const sqlite=new DatabaseSync(databasePath,{timeout:5000,enableForeignKeyConstraints:true});
  try {
    sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const check=sqlite.prepare('PRAGMA quick_check').get();
    if(Object.values(check)[0]!=='ok')throw new Error('データベースの整合性を確認できません。データは初期化せず、バックアップを確認してください。');
    // v1 is schema.sql; later versions are additive files in migrations/ applied in order, each verified by hash.
    const migrations=[{version:1,path:schemaPath},{version:2,path:join(dirname(schemaPath),'migrations','002_children.sql')},{version:3,path:join(dirname(schemaPath),'migrations','003_name.sql')},{version:4,path:join(dirname(schemaPath),'migrations','004_no_name.sql')},{version:5,path:join(dirname(schemaPath),'migrations','005_events.sql')},{version:6,path:join(dirname(schemaPath),'migrations','006_event_kinds.sql')}];
    sqlite.exec('CREATE TABLE IF NOT EXISTS app_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    const newest=sqlite.prepare('SELECT MAX(version) AS v FROM app_migrations').get().v??0;
    if(newest>migrations.length)throw new Error('このデータは新しい版のプログラムで作られています。新しい版で起動してください。');
    for(const {version,path} of migrations){
      const sql=readFileSync(path,'utf8');
      const hash=createHash('sha256').update(sql).digest('hex');
      const applied=sqlite.prepare('SELECT sha256 FROM app_migrations WHERE version=?').get(version);
      if(applied){if(applied.sha256!==hash)throw new Error('既存データとプログラムのDB定義が一致しません。自動で書き換えずに停止します。');continue;}
      if(version===1&&sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rounds','tickets')").get())throw new Error('版情報のない既存データを検出しました。上書きせずに停止します。');
      sqlite.exec('BEGIN IMMEDIATE');
      try{sqlite.exec(sql);sqlite.prepare('INSERT INTO app_migrations(version,sha256) VALUES(?,?)').run(version,hash);sqlite.exec('COMMIT');}
      catch(e){sqlite.exec('ROLLBACK');throw e;}
    }
    const meta=key=>sqlite.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value;
    const put=(key,value)=>sqlite.prepare('INSERT OR IGNORE INTO app_metadata(key,value) VALUES(?,?)').run(key,value);
    put('installation_id',randomUUID());put('installation_secret',randomBytes(32).toString('hex'));put('staff_code',String(randomInt(10000000,100000000)));
    const installationId=meta('installation_id'),installationSecret=meta('installation_secret'),staffCode=meta('staff_code');
    // node:sqlite is synchronous: no other request can interleave inside this callback.
    function transaction(work){
      sqlite.exec('BEGIN IMMEDIATE');
      try{const result=work();sqlite.exec('COMMIT');return result;}
      catch(e){sqlite.exec('ROLLBACK');throw e;}
    }
    async function snapshot(destination){
      mkdirSync(join(destination,'..'),{recursive:true});
      const temporary=destination+'.part';
      await backup(sqlite,temporary);
      renameSync(temporary,destination);
      return destination;
    }
    function close(){try{sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{sqlite.close();}}
    return {sqlite,transaction,databasePath,installationId,installationSecret,staffCode,snapshot,close};
  }catch(e){sqlite.close();throw e;}
}

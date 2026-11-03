import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const home = mkdtempSync(join(tmpdir(), 'connect-scope-'));
try {
 const source = new URL('../lib/auth.js', import.meta.url).pathname;
 execFileSync(process.execPath, ['-e', `
const assert=require('node:assert/strict');const a=require(${JSON.stringify(source)});
(async()=>{
 const calls=[];global.fetch=async(url,opts={})=>{calls.push([url,opts]);if(url.includes('well-known'))return {ok:true,json:async()=>({registration_endpoint:'https://fixture/register',device_authorization_endpoint:'https://fixture/device'})};if(url.endsWith('register'))return {ok:true,json:async()=>({client_id:'new-client'})};return {ok:true,json:async()=>({device_code:'fixture'})};};
 const old={client_id:'old-client',issuer:a.ISSUER};a.save(a.CLIENT,old);
 a.save(a.CREDS,{refresh_token:'old-fixture',access_token:'old',issuer:a.ISSUER,obtained_at:Date.now(),expires_in:300});
 assert.equal(a.isLinked(),false);assert.equal(await a.accessToken(),null);assert.equal(calls.length,0);
 await a.beginDeviceAuth();assert.equal(a.load(a.CLIENT).client_id,'new-client');assert.equal(a.load(a.CREDS).refresh_token,'old-fixture');
 const reg=JSON.parse(calls.find(c=>c[0].endsWith('register'))[1].body);assert.ok(reg.scope.split(' ').includes('quadron-mcp'));
 assert.ok(calls.find(c=>c[0].endsWith('device'))[1].body.get('scope').split(' ').includes('quadron-mcp'));
 await a.ensureClient();assert.equal(calls.filter(c=>c[0].endsWith('register')).length,1);
 assert.ok(calls.every(c=>c[1].redirect==='error'&&c[1].signal));
 a.save(a.CLIENT,old);global.fetch=async()=>({ok:false,status:503,text:async()=>''});
 await assert.rejects(a.ensureClient());assert.deepEqual(a.load(a.CLIENT),old);assert.equal(a.load(a.CREDS).refresh_token,'old-fixture');
 a.save(a.CREDS,{issuer:a.ISSUER,scope:a.SCOPE,scope_version:a.SCOPE_VERSION,refresh_token:'fixture',access_token:'scoped',obtained_at:Date.now(),expires_in:300});
 assert.equal(a.isLinked(),true);assert.equal(await a.accessToken(),'scoped');
 a.save(a.CREDS,{issuer:'https://other',scope:a.SCOPE,scope_version:1,refresh_token:'fixture'});assert.equal(await a.accessToken(),null);
})().catch(e=>{console.error(e);process.exitCode=1});
`], {env:{PATH:process.env.PATH,HOME:home},timeout:5000,stdio:'pipe'});
 const configDir = join(home, '.quadron');
 writeFileSync(join(configDir, 'credentials.json'), JSON.stringify({issuer:'https://app.quadron.tech/auth/realms/quadron',scope:'openid quadron-mcp',scope_version:1,refresh_token:'fixture',access_token:'fixture',obtained_at:Date.now(),expires_in:300}));
 const preload = join(home, 'hung-fetch.js');
 writeFileSync(preload, 'global.fetch=()=>new Promise(()=>{});');
 const started = Date.now();
 const output = execFileSync(process.execPath, ['--require',preload,new URL('../hooks/session-start.js',import.meta.url).pathname], {env:{PATH:process.env.PATH,HOME:home},input:'',timeout:3500,encoding:'utf8'});
 assert.equal(output,'');assert.ok(Date.now()-started<3000);
 assert.ok(true);
 console.log('Scoped registration migration, custody preservation, redirect/timeout and issuer isolation PASS');
} finally { rmSync(home,{recursive:true,force:true}); }

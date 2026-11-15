import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import Ajv from 'ajv';
import {resolvePluginConfig} from '../src/config.mjs';
import {resolveEnv} from '../src/webhook.mjs';
import {config as jsonConfig,host} from './fixtures.mjs';
import {selectRoute,buildRequest} from '../src/routes.mjs';
const env=()=>({MAIL_ROUTER_HOST:'imap.example.org',MAIL_ROUTER_USER:'aisa@example.org',MAIL_ROUTER_PASSWORD:'only-test-${DO_NOT_EXPAND}',MAIL_ROUTER_FALLBACK_AGENT_ID:'aisa',MAIL_ROUTER_ALLOWED_SENDERS:'sender@example.org, @partner.example.org',MAIL_ROUTER_TRUSTED_AUTHSERV_IDS:'mx.example.org',MAIL_ROUTER_TRUST_RECEIVER:'true',MAIL_ROUTER_RECIPIENT:'aisa+alpha@example.org',MAIL_ROUTER_AGENT_ID:'alpha',MAIL_ROUTER_WHATSAPP_GROUP:'111@g.us'});
test('environment mode generates a validated mailbox and authorized route',()=>{
  const values=env();const c=resolvePluginConfig({fromEnv:true},values);
  assert.equal(c.accounts.shared.host,'imap.example.org');assert.equal(c.accounts.shared.secure,true);
  assert.equal(c.accounts.shared.deliver,false);assert.equal(c.accounts.shared.agentId,'aisa');
  assert.deepEqual(c.accounts.shared.allowedSenders,['sender@example.org','@partner.example.org']);
  assert.deepEqual(c.recipientNamespaces,['aisa@example.org']);assert.equal(c.startFrom,undefined);
  assert.equal(resolveEnv(c.accounts.shared.password,values),values.MAIL_ROUTER_PASSWORD);
  assert.equal(JSON.stringify(c).includes(values.MAIL_ROUTER_PASSWORD),false);
  const route=selectRoute({to:{value:[{address:'aisa+alpha@example.org'}]}},c,'shared');
  const request=buildRequest({santalRecipientRoute:route,idempotencyKey:'test',message:'mail'},host,c,'shared');
  assert.equal(request.agentId,'alpha');assert.equal(request.to,'111@g.us');
});
test('existing JSON configuration ignores unrelated environment variables and remains unchanged',()=>{
  const original=structuredClone(jsonConfig);
  assert.deepEqual(resolvePluginConfig(jsonConfig,{MAIL_ROUTER_HOST:'other'}),original);
  assert.deepEqual(resolvePluginConfig({...jsonConfig,fromEnv:false},env()),original);
  assert.deepEqual(jsonConfig,original);
});
test('environment mode cannot be combined with authored JSON settings',()=>{
  for(const patch of [{routes:[]},{accounts:{}},{startFrom:'now'},{recipientNamespaces:[]}])assert.throws(()=>resolvePluginConfig({fromEnv:true,...patch},env()),/cannot be mixed/);
  assert.throws(()=>resolvePluginConfig({fromEnv:'true'},env()),/must be boolean/);
});
test('missing credentials name the variable but never reveal other credential values',()=>{
  for(const name of ['MAIL_ROUTER_USER','MAIL_ROUTER_PASSWORD','MAIL_ROUTER_HOST']){
    const values=env();delete values[name];
    assert.throws(()=>resolvePluginConfig({fromEnv:true},values),error=>error.message.includes(name)&&!error.message.includes(values.MAIL_ROUTER_PASSWORD||'not-a-real-secret'));
  }
});
test('trusted receiver opt-in is explicit and case-sensitive',()=>{
  for(const value of [undefined,'false','TRUE','1',''])assert.throws(()=>resolvePluginConfig({fromEnv:true},{...env(),MAIL_ROUTER_TRUST_RECEIVER:value}),/must explicitly be true/);
});
test('numeric options, lists and start cursor policy are validated',()=>{
  for(const patch of [{MAIL_ROUTER_PORT:'0'},{MAIL_ROUTER_PORT:'993x'},{MAIL_ROUTER_POLL_SECONDS:'14'},{MAIL_ROUTER_MAX_BYTES:'99999999'},{MAIL_ROUTER_START_FROM:'all'},{MAIL_ROUTER_ALLOWED_SENDERS:', ,'}])assert.throws(()=>resolvePluginConfig({fromEnv:true},{...env(),...patch}));
  const c=resolvePluginConfig({fromEnv:true},{...env(),MAIL_ROUTER_START_FROM:'now',MAIL_ROUTER_POLL_SECONDS:'30'});
  assert.equal(c.startFrom,'now');assert.equal(c.accounts.shared.watch.pollSeconds,30);
  assert.equal(resolvePluginConfig({fromEnv:true},{...env(),MAIL_ROUTER_ROUTE_ID:'alpha'}).routes[0].id,'alpha');
});
test('advanced route array supports multiple clients and rejects ambiguous route modes',()=>{
  const values=env();for(const key of ['MAIL_ROUTER_RECIPIENT','MAIL_ROUTER_AGENT_ID','MAIL_ROUTER_WHATSAPP_GROUP'])delete values[key];
  values.MAIL_ROUTER_ROUTES_JSON=JSON.stringify(jsonConfig.routes);
  assert.equal(resolvePluginConfig({fromEnv:true},values).routes.length,2);
  for(const invalid of ['broken-json-secret','{}','[]'])assert.throws(()=>resolvePluginConfig({fromEnv:true},{...values,MAIL_ROUTER_ROUTES_JSON:invalid}),error=>!error.message.includes(invalid));
  assert.throws(()=>resolvePluginConfig({fromEnv:true},{...values,MAIL_ROUTER_AGENT_ID:'alpha'}),/choose/);
});
test('custom account ID is preserved when authored in advanced routes',()=>{
  const values=env();for(const key of ['MAIL_ROUTER_RECIPIENT','MAIL_ROUTER_AGENT_ID','MAIL_ROUTER_WHATSAPP_GROUP'])delete values[key];
  values.MAIL_ROUTER_ACCOUNT_ID='aisa';values.MAIL_ROUTER_ROUTES_JSON=JSON.stringify(jsonConfig.routes.map(r=>({...r,accountId:'aisa'})));
  assert.ok(resolvePluginConfig({fromEnv:true},values).accounts.aisa);
});
test('manifest accepts either complete JSON config or env-only opt-in; rejects incomplete and mixed configs',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../openclaw.plugin.json',import.meta.url),'utf8'));
  const validate=new Ajv({strict:false}).compile(manifest.configSchema);
  for(const input of [jsonConfig,{...jsonConfig,fromEnv:false},{fromEnv:true}])assert.equal(validate(input),true,JSON.stringify(validate.errors));
  for(const input of [{},{fromEnv:false},{fromEnv:'true'},{fromEnv:true,accounts:{}},{...jsonConfig,fromEnv:true}])assert.equal(validate(input),false);
  assert.ok(manifest.configContracts.dangerousFlags.some(flag=>flag.path==='fromEnv'&&flag.equals===true));
});
test('documented .env.example parses into usable configuration without storing password in JSON',()=>{
  const values=parseEnv(readFileSync(new URL('../.env.example',import.meta.url),'utf8'));
  const c=resolvePluginConfig({fromEnv:true},values);
  assert.equal(c.routes[0].agentId,'client-a');assert.equal(c.startFrom,'now');assert.equal(c.accounts.shared.user.id,'MAIL_ROUTER_USER');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {simpleParser} from 'mailparser';
import {ImapFlow} from 'imapflow';
import {sweep} from '../src/collector.mjs';
import {resolvePluginConfig} from '../src/config.mjs';
import {StateStore} from '../src/state.mjs';
import {dispatch} from '../src/webhook.mjs';
import {buildRequest,validateRouting} from '../src/routes.mjs';
import {config,host} from './fixtures.mjs';
const source=Buffer.from([
  'From: Operator <sender@example.org>',
  'To: Assistant <aisa+alpha@example.org>',
  'Subject: =?UTF-8?Q?Appel_=C3=A0_projets?=',
  'Message-ID: <integration@example.org>',
  'Authentication-Results: mx.example.org; dmarc=pass header.from=example.org',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Nouvelle opportunité : formation et accompagnement.',
].join('\r\n'));
for(const mode of ['json','environment'])test(`real MIME parser and loopback HTTP exercise ${mode} collector-to-webhook path`,async()=>{
  assert.equal(typeof ImapFlow,'function');
  const root=mkdtempSync(join(tmpdir(),'mail-router-integration-'));
  const store=new StateStore(root);store.open();
  store.data.mailboxes.shared={uidValidity:'123',lastSeenUid:1,recent:[],outcomes:[]};store.save();
  let received;
  const server=createServer(async(req,res)=>{
    let bytes='';for await(const chunk of req)bytes+=chunk;
    received={path:req.url,auth:req.headers.authorization,body:JSON.parse(bytes)};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,runId:'http-test',completion:{status:'ok',delivered:true}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const resolved=mode==='json'?resolvePluginConfig(config):resolvePluginConfig({fromEnv:true},{MAIL_ROUTER_HOST:'imap.example.org',MAIL_ROUTER_USER:'aisa@example.org',MAIL_ROUTER_PASSWORD:'test-only',MAIL_ROUTER_FALLBACK_AGENT_ID:'aisa',MAIL_ROUTER_ALLOWED_SENDERS:'sender@example.org',MAIL_ROUTER_TRUSTED_AUTHSERV_IDS:'mx.example.org',MAIL_ROUTER_TRUST_RECEIVER:'true',MAIL_ROUTER_RECIPIENT:'aisa+alpha@example.org',MAIL_ROUTER_AGENT_ID:'alpha',MAIL_ROUTER_WHATSAPP_GROUP:'111@g.us'});
    const account={...resolved.accounts.shared,allowedSenders:['sender@example.org'],senderAuth:{min:'asserted',acceptTrustedAuthservId:true,trustedAuthservIds:['mx.example.org']}};
    const client={mailbox:{uidValidity:123n,uidNext:3},getMailboxLock:async()=>({release(){}}),async*fetch(){yield {uid:2,size:source.length};},fetchOne:async()=>({source})};
    const target={...host,gateway:{port:server.address().port}};
    await sweep({client,parse:simpleParser,state:store,accountId:'shared',account,config:resolved,log:{info(){},warn(){}},deliver:value=>dispatch(buildRequest(value,target,resolved,'shared'),target)});
    assert.equal(received.path,'/hooks/agent');assert.equal(received.auth,'Bearer unit-only-hook');
    assert.equal(received.body.agentId,'alpha');assert.equal(received.body.to,'111@g.us');
    assert.match(received.body.message,/Appel à projets/);assert.match(received.body.message,/formation/);
    assert.equal(store.data.mailboxes.shared.lastSeenUid,2);assert.equal(store.data.mailboxes.shared.pending,undefined);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});}
});
test('generic example configuration validates',async()=>{
  const {readFile}=await import('node:fs/promises');
  validateRouting(JSON.parse(await readFile(new URL('../examples/config.json',import.meta.url),'utf8')));
});

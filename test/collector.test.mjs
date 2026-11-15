import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from '../src/state.mjs';
import {sweep} from '../src/collector.mjs';
import {authorize} from '../src/auth.mjs';
import {config as fixture,mail} from './fixtures.mjs';
const account={...fixture.accounts.shared,allowedSenders:['sender@example.org'],senderAuth:{min:'asserted',acceptTrustedAuthservId:true,trustedAuthservIds:['mx.example.org']}};
function parsed(address='aisa+alpha@example.org') {return {...mail(address),from:{value:[{address:'sender@example.org'}]},headerLines:[{key:'from',line:'From: sender@example.org'},{key:'authentication-results',line:'Authentication-Results: mx.example.org; dmarc=pass header.from=example.org'}],text:'Test',messageId:'<unique-message@example.org>'};}
const log={info(){},warn(){}};
async function fixtureTest(fn){const root=mkdtempSync(join(tmpdir(),'mail-independent-'));const state=new StateStore(root);state.open();try{await fn(state,root);}finally{state.close();rmSync(root,{recursive:true,force:true});}}
function client(items=[{uid:2,size:100}]){return {mailbox:{uidValidity:123n,uidNext:3},getMailboxLock:async(_path,opts)=>{assert.equal(opts.readOnly,true);return {release(){}};},async*fetch(){for(const item of items)yield item;},fetchOne:async()=>({source:Buffer.from('test')})};}
function cursor(state){state.data.mailboxes.shared={uidValidity:'123',lastSeenUid:1,recent:[],outcomes:[]};state.save();}
function options(state,overrides={}){return {state,client:client(),parse:async()=>parsed(),accountId:'shared',account,config:fixture,log,deliver:async()=>({ok:true,runId:'run',completion:{status:'ok',delivered:true}}),...overrides};}
test('new collector requires explicit baseline; baseline does not dispatch existing mail',async()=>fixtureTest(async state=>{
  await assert.rejects(sweep(options(state)),/No cursor/);let sent=0;
  await sweep(options(state,{config:{...fixture,startFrom:'now'},deliver:async()=>{sent++;}}));
  assert.equal(sent,0);assert.equal(state.data.mailboxes.shared.lastSeenUid,2);
}));
test('new UID routed once, cursor persisted and no IMAP writes',async()=>fixtureTest(async(state,root)=>{
  cursor(state);let sent=0;await sweep(options(state,{deliver:async value=>{sent++;assert.equal(value.santalRecipientRoute.id,'alpha');assert.ok(state.data.mailboxes.shared.pending);return {runId:'run',completion:{status:'ok',delivered:true}};}}));
  await sweep(options(state,{deliver:async()=>{sent++;}}));assert.equal(sent,1);
  assert.equal(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).mailboxes.shared.lastSeenUid,2);
}));
test('unknown client and unauthorized senders are skipped without dispatch',async()=>fixtureTest(async state=>{
  cursor(state);let sent=0;
  await sweep(options(state,{parse:async()=>parsed('aisa+unknown@example.org'),deliver:async()=>{sent++;}}));
  assert.equal(sent,0);assert.equal(state.data.mailboxes.shared.outcomes[0].status,'unconfigured-client-recipient');
}));
test('uncertain dispatch survives restart and never automatically resends',async()=>fixtureTest(async(state,root)=>{
  cursor(state);let sent=0;
  await assert.rejects(sweep(options(state,{deliver:async()=>{sent++;throw new Error('network lost');}})),/uncertain/);
  const saved=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));assert.equal(saved.mailboxes.shared.pending.status,'prepared');
  await assert.rejects(sweep(options(state,{deliver:async()=>{sent++;}})),/previous dispatch/);assert.equal(sent,1);
}));
test('UIDVALIDITY change halts instead of replaying mailbox',async()=>fixtureTest(async state=>{
  cursor(state);const c=client();c.mailbox.uidValidity=456n;await assert.rejects(sweep(options(state,{client:c})),/UIDVALIDITY/);
}));
test('state lock prevents two collectors and persisted state reloads',async()=>fixtureTest(async(state,root)=>{
  cursor(state);const other=new StateStore(root);assert.throws(()=>other.open(),/locked/);
  state.close();other.open();assert.equal(other.data.mailboxes.shared.lastSeenUid,1);other.close();
}));
test('admitted terminal failure is recorded without retrying the mail',async()=>fixtureTest(async state=>{
  cursor(state);await sweep(options(state,{deliver:async()=>({runId:'failure',completion:{status:'error',deliveryError:'delivery-failed'}})}));
  assert.equal(state.data.mailboxes.shared.lastSeenUid,2);assert.equal(state.data.mailboxes.shared.outcomes[0].status,'terminal-failure');
}));
test('trusted receiver DMARC assertions checked against sender domain',()=>{
  assert.equal(authorize(parsed(),account).ok,true);
  for(const line of [
    'Authentication-Results: attacker.org; dmarc=pass header.from=example.org',
    'Authentication-Results: mx.example.org; dmarc=fail header.from=example.org',
    'Authentication-Results: mx.example.org; dmarc=pass header.from=other.org',
    'Authentication-Results: mx.example.org; dmarc=pass reason="header.from=example.org"',
    'Authentication-Results: mx.example.org; spf=pass (dmarc=pass header.from=example.org)',
  ]){const m=parsed();m.headerLines[1].line=line;assert.equal(authorize(m,account).ok,false,line);}
  const duplicate=parsed();duplicate.headerLines.push(duplicate.headerLines[1]);assert.equal(authorize(duplicate,account).ok,false);
});

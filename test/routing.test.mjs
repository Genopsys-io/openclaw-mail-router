import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRouting,selectRoute,buildRequest} from '../src/routes.mjs';
import {config,host,mail,value} from './fixtures.mjs';
test('two independent clients route without source-code changes',()=>{
  validateRouting(config);
  for (const id of ['alpha','beta']) {
    const route=selectRoute(mail(`AISA+${id.toUpperCase()}@EXAMPLE.ORG`),config,'shared');
    assert.deepEqual(route,{id});
    const request=buildRequest({...value(id),santalRecipientRoute:route},host,config,'shared');
    assert.equal(request.agentId,id);assert.equal(request.to,id==='alpha'?'111@g.us':'222@g.us');
    assert.equal(request.sessionMode,'isolated');assert.equal(request.sessionKey,undefined);
  }
});
test('ordinary mail preserves fallback; body, subject and display name do not route',()=>{
  const m=mail('aisa@example.org');Object.assign(m,{text:'aisa+alpha@example.org',subject:'aisa+alpha@example.org'});m.to.value[0].name='aisa+alpha@example.org';
  assert.equal(selectRoute(m,config,'shared'),undefined);
});
test('parsed recipient and original-delivery headers route',()=>{
  for(const field of ['cc','bcc'])assert.deepEqual(selectRoute({[field]:mail('aisa+alpha@example.org').to},config,'shared'),{id:'alpha'});
  for(const key of ['delivered-to','x-original-to','envelope-to','x-envelope-to'])assert.deepEqual(selectRoute({headerLines:[{key,line:`${key}: <aisa+alpha@example.org>`}]},config,'shared'),{id:'alpha'});
});
test('mixed clients, unknown alias and wrong mailbox fail closed',()=>{
  assert.equal(selectRoute(mail('aisa+alpha@example.org','aisa+beta@example.org'),config,'shared').reject,true);
  assert.equal(selectRoute(mail('aisa+gamma@example.org'),config,'shared').reason,'unconfigured-client-recipient');
  assert.equal(selectRoute(mail('aisa+alpha@example.org','aisa+gamma@example.org'),config,'shared').reject,true);
  assert.equal(selectRoute(mail('aisa+alpha@example.org'),config,'other').reason,'wrong-mailbox-for-route');
});
test('invalid configuration rejected before watchers start',()=>{
  const duplicate=structuredClone(config);duplicate.routes[1].recipients=['AISA+ALPHA@EXAMPLE.ORG'];assert.throws(()=>validateRouting(duplicate));
  const wrong=structuredClone(config);wrong.routes[0].accountId='missing';assert.throws(()=>validateRouting(wrong));
  const deliver=structuredClone(config);deliver.accounts.shared.deliver=true;assert.throws(()=>validateRouting(deliver));
});
test('request uses configured destination, ignores forged destination, isolates replay identities',()=>{
  const a=buildRequest({...value('alpha'),santalRecipientRoute:{id:'alpha',to:'222@g.us',agentId:'beta'}},host,config,'shared');
  assert.equal(a.to,'111@g.us');assert.equal(a.agentId,'alpha');
  assert.equal(a.idempotencyKey,buildRequest(value('alpha'),host,config,'shared').idempotencyKey);
  assert.notEqual(a.idempotencyKey,buildRequest(value('beta'),host,config,'shared').idempotencyKey);
  assert.throws(()=>buildRequest(value('unknown'),host,config,'shared'));
});
test('tools and account-specific group bindings are mandatory',()=>{
  const bad=structuredClone(host);bad.agents.entries.alpha.tools.deny=[];assert.throws(()=>buildRequest(value('alpha'),bad,config,'shared'));
  const other=structuredClone(host);other.bindings[0].match.accountId='another';assert.throws(()=>buildRequest(value('alpha'),other,config,'shared'));
  assert.throws(()=>buildRequest(value('alpha'),{...host,bindings:[]},config,'shared'));
});

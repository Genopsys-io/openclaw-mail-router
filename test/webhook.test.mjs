import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatch,resolveEnv} from '../src/webhook.mjs';
import {buildRequest} from '../src/routes.mjs';
import {host,config,value} from './fixtures.mjs';
test('public webhook receives exact authorized payload and dedicated token',async()=>{
  const request=buildRequest(value('alpha'),host,config,'shared');
  const result=await dispatch(request,host,{fetchImpl:async(url,init)=>{
    assert.equal(url,'http://127.0.0.1:18789/hooks/agent');assert.equal(init.headers.Authorization,'Bearer unit-only-hook');
    assert.equal(init.headers['Idempotency-Key'],request.idempotencyKey);assert.deepEqual(JSON.parse(init.body),request);assert.equal(init.redirect,'error');
    return {ok:true,json:async()=>({ok:true,runId:'accepted',completion:{status:'ok',delivered:true}})};
  }});
  assert.equal(result.completion.delivered,true);
});
test('HTTP errors never expose response secrets and invalid admission rejected',async()=>{
  const request=buildRequest(value('alpha'),host,config,'shared');
  await assert.rejects(dispatch(request,host,{fetchImpl:async()=>({ok:false,status:401,text:async()=>'secret response'})}),/^Error: Mail webhook HTTP 401$/);
  await assert.rejects(dispatch(request,host,{fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})}),/no admitted run/);
  await assert.rejects(dispatch(request,{...host,hooks:{enabled:false}}));
});
test('credential env strings and env references supported; missing/store references fail',()=>{
  assert.equal(resolveEnv('${USER}',{USER:'username'}),'username');
  assert.equal(resolveEnv({source:'env',id:'PASSWORD'},{PASSWORD:'password'}),'password');
  assert.throws(()=>resolveEnv('${MISSING}',{}));assert.throws(()=>resolveEnv({source:'store',id:'x'},{}));
});

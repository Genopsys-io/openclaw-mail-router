#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {StateStore} from '../src/state.mjs';
const args=process.argv.slice(2);
if(!args.includes('--state-dir')||!args.includes('--input'))throw new Error('Usage: node scripts/import-cursors.mjs --state-dir DIRECTORY --input exported-cursors.json [--write]');
const directory=args[args.indexOf('--state-dir')+1],input=args[args.indexOf('--input')+1];
const cursors=JSON.parse(readFileSync(input,'utf8'));
if(!cursors||Array.isArray(cursors)||!Object.keys(cursors).length)throw new Error('Expected accountId -> {uidValidity,lastSeenUid}');
for(const [accountId,cursor]of Object.entries(cursors)) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(accountId)||!/^\d+$/.test(cursor.uidValidity)||!Number.isSafeInteger(cursor.lastSeenUid)||cursor.lastSeenUid<0)throw new Error('Invalid cursor export');
}
if(!args.includes('--write'))console.log(`Validated ${Object.keys(cursors).length} cursor(s); no files written.`);
else {
  const state=new StateStore(directory);state.open();
  try {
    if(Object.keys(state.data.mailboxes).length)throw new Error('Refusing to overwrite existing independent collector state');
    for(const [accountId,c]of Object.entries(cursors))state.data.mailboxes[accountId]={uidValidity:String(c.uidValidity),lastSeenUid:c.lastSeenUid,recent:[],outcomes:[]};
    state.save();console.log('Cursors imported. Keep old collector stopped before starting this one.');
  }finally{state.close();}
}

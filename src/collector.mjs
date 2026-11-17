import {createHash} from 'node:crypto';
import {selectRoute} from './routes.mjs';
import {authorize} from './auth.mjs';
import {analysisMessage} from './analyzer.mjs';
export async function sweep({client,parse,state,accountId,account,config,deliver,analyze,log,signal}) {
  const lock=await client.getMailboxLock(account.mailbox||'INBOX',{readOnly:true});
  try{
    const mailbox=client.mailbox;
    const validity=String(mailbox.uidValidity);
    if(!/^\d+$/.test(validity)||!Number.isSafeInteger(Number(mailbox.uidNext))||Number(mailbox.uidNext)<1)throw new Error('Invalid mailbox metadata');
    let cursor=state.data.mailboxes[accountId];
    if(!cursor) {
      if(config.startFrom!=='now')throw new Error('No cursor: explicitly choose startFrom:now or import a cursor before activation');
      cursor=state.data.mailboxes[accountId]={uidValidity:validity,lastSeenUid:Math.max(0,Number(mailbox.uidNext)-1),recent:[],outcomes:[]};state.save();
      log.info(`mail-router: account=${accountId} baseline uid=${cursor.lastSeenUid}`);return;
    }
    if(!Number.isSafeInteger(cursor.lastSeenUid)||cursor.lastSeenUid<0)throw new Error('Invalid saved cursor');
    if(cursor.lastSeenUid>=Number(mailbox.uidNext))throw new Error('Saved cursor is ahead of mailbox; reconcile state before resuming');
    if(cursor.uidValidity!==validity)throw new Error('UIDVALIDITY changed; reconcile mailbox state before resuming');
    if(cursor.pending)throw new Error('A previous dispatch has an uncertain outcome; inspect pending state before resuming');
    const metadata=[];
    for await(const item of client.fetch(`${cursor.lastSeenUid+1}:*`,{uid:true,size:true},{uid:true})) {
      if(item.uid>cursor.lastSeenUid&&metadata.length<50)metadata.push(item);
    }
    metadata.sort((a,b)=>a.uid-b.uid);
    for(const item of metadata) {
      if(signal?.aborted)return;
      const finish=(status,detail={})=>{
        cursor.lastSeenUid=item.uid;delete cursor.pending;
        cursor.outcomes.push({uid:item.uid,status,...detail,at:new Date().toISOString()});cursor.outcomes=cursor.outcomes.slice(-200);state.save();
        log.info(`mail-router: account=${accountId} uid=${item.uid} status=${status}`);
      };
      if(!Number.isFinite(item.size)||item.size>1048576){finish('message-too-large');continue;}
      const full=await client.fetchOne(item.uid,{source:true},{uid:true});
      if(!full?.source){finish('message-removed');continue;}
      if(full.source.length>1048576){finish('message-too-large');continue;}
      let mail;try{mail=await parse(full.source,{skipHtmlToText:false,skipImageLinks:true,skipTextToHtml:true});}catch{finish('parse-failed');continue;}
      const route=selectRoute(mail,config,accountId);
      if(route?.reject){finish(route.reason);continue;}
      const verdict=authorize(mail,account);if(!verdict.ok){finish(verdict.reason);continue;}
      const digest=mail.messageId?createHash('sha256').update(mail.messageId).digest('hex'):null;
      if(digest&&cursor.recent.includes(digest)){finish('duplicate-message-id');continue;}
      const key=`santal-imap:${accountId}:${validity}:${item.uid}`;
      const content=analyze
        ? analysisMessage({...mail,text:account.includeBody===false?'':mail.text||''},verdict.sender,await analyze(account.includeBody===false?{...mail,text:'',html:''}:mail,{signal}),account.maxBytes||20000)
        : JSON.stringify({from:verdict.sender,subject:mail.subject||'',text:account.includeBody===false?'':mail.text||'',attachments:(mail.attachments||[]).map(a=>a.filename||'unnamed')});
      // Persist intent BEFORE the external side effect. A crash blocks this UID for manual reconciliation.
      cursor.pending={uid:item.uid,idempotencyKey:key,status:'prepared'};state.save();
      let result;
      try{result=await deliver({santalRecipientRoute:route,idempotencyKey:key,message:Buffer.from(content).subarray(0,account.maxBytes||20000).toString('utf8')});}
      catch{throw new Error('Dispatch outcome uncertain; inspect pending state and Gateway logs before retrying');}
      cursor.pending={...cursor.pending,runId:result.runId,status:'admitted'};state.save();
      if(!result.completion)throw new Error('Run admitted but completion unknown; inspect pending run before resuming');
      if(digest){cursor.recent.push(digest);cursor.recent=cursor.recent.slice(-2000);}
      const c=result.completion;
      finish(c.status==='ok'&&!c.deliveryError?'completed':'terminal-failure',{runId:result.runId,completion:c});
      if(route&&c.delivered!==true)log.warn(`mail-router: account=${accountId} uid=${item.uid} delivery unconfirmed run=${result.runId}`);
    }
  }finally{lock.release();}
}

// Conservative subset of RFC 8601: unsupported or ambiguous syntax fails closed.
function clauses(text) {
  const parts=[];let current='',depth=0,quoted=false,escaped=false;
  for(const char of text) {
    if(escaped){if(!depth)current+=char;escaped=false;continue;}
    if(char==='\\'){if(!depth)current+=char;escaped=true;continue;}
    if(depth){if(char==='(')depth++;if(char===')')depth--;continue;}
    if(!quoted && char==='('){depth=1;current+=' ';continue;}
    if(char==='"')quoted=!quoted;
    if(char===';'&&!quoted){parts.push(current.trim());current='';}else current+=char;
  }
  if(depth||quoted||escaped)throw new Error('Malformed authentication header');
  parts.push(current.trim());return parts;
}
export function authorize(mail, account) {
  const senders=mail.from?.value || [];
  const fromHeaders=(mail.headerLines||[]).filter(h=>h.key?.toLowerCase()==='from');
  if(senders.length!==1||fromHeaders.length!==1)return {ok:false,reason:'ambiguous-from'};
  const sender=senders[0].address?.toLowerCase();
  if(!sender || !sender.includes('@'))return {ok:false,reason:'missing-sender'};
  const domain=sender.slice(sender.lastIndexOf('@')+1);
  if(!(account.allowedSenders||[]).some(entry=>entry.toLowerCase()===sender||entry.toLowerCase()===`@${domain}`))return {ok:false,reason:'sender-not-allowed'};
  const policy=account.senderAuth;
  if(policy?.min!=='asserted'||policy.acceptTrustedAuthservId!==true)return {ok:false,reason:'unsupported-auth-policy'};
  const trusted=(policy.trustedAuthservIds||[]).map(id=>id.toLowerCase());
  const results=[];
  for(const header of mail.headerLines||[]) {
    if(header.key?.toLowerCase()!=='authentication-results')continue;
    try{
      const parts=clauses(header.line.replace(/^[^:]+:/,'').replace(/\r?\n[ \t]+/g,' '));
      const service=parts.shift().toLowerCase();
      if(!trusted.includes(service))continue;
      for(const part of parts) {
        const method=/^dmarc\s*=\s*([a-z]+)(?:\s|$)/i.exec(part);if(!method)continue;
        // Tokenize outside quoted strings so text inside a reason cannot become a property.
        const tokens=[];let token='',quoted=false,escaped=false;
        for(const char of part) {
          if(escaped){token+=char;escaped=false;continue;}
          if(char==='\\'){escaped=true;continue;}
          if(char==='"'){quoted=!quoted;continue;}
          if(/\s/.test(char)&&!quoted){if(token)tokens.push(token);token='';}else token+=char;
        }
        if(token)tokens.push(token);
        const fields=tokens.filter(t=>/^header\.from=[a-z0-9.-]+$/i.test(t));
        results.push(/^dmarc=pass$/i.test(tokens[0])&&fields.length===1&&fields[0].slice('header.from='.length).toLowerCase()===domain);
      }
    }catch{return {ok:false,reason:'malformed-authentication-results'};}
  }
  return results.length===1&&results[0]?{ok:true,sender}:{ok:false,reason:'unverified-authentication'};
}

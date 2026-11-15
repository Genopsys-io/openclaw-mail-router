import {validateRouting} from './routes.mjs';
function required(env,name,{trim=true}={}) {
  const value=env[name];
  if(typeof value!=='string'||!(trim?value.trim():value))throw new Error(`Mail router: missing environment variable ${name}`);
  return trim?value.trim():value;
}
function list(env,name) {
  const values=required(env,name).split(',').map(v=>v.trim()).filter(Boolean);
  if(!values.length)throw new Error(`Mail router: empty environment list ${name}`);
  return [...new Set(values)];
}
function integer(env,name,fallback,min,max) {
  if(env[name]===undefined)return fallback;
  const text=env[name].trim();
  if(!/^\d+$/.test(text)||Number(text)<min||Number(text)>max)throw new Error(`Mail router: invalid integer ${name}`);
  return Number(text);
}
function jsonRoutes(env) {
  let routes;
  try{routes=JSON.parse(required(env,'MAIL_ROUTER_ROUTES_JSON'));}
  catch{throw new Error('Mail router: invalid JSON in MAIL_ROUTER_ROUTES_JSON');}
  if(!Array.isArray(routes)||!routes.length)throw new Error('Mail router: MAIL_ROUTER_ROUTES_JSON must be a nonempty array');
  return routes;
}
export function resolvePluginConfig(authored,env=process.env) {
  const input=structuredClone(authored||{});
  if(input.fromEnv!==undefined&&typeof input.fromEnv!=='boolean')throw new Error('Mail router: fromEnv must be boolean');
  if(input.fromEnv!==true){delete input.fromEnv;validateRouting(input);return input;}
  if(Object.keys(input).some(key=>key!=='fromEnv'))throw new Error('Mail router: fromEnv cannot be mixed with JSON account or route settings');
  const host=required(env,'MAIL_ROUTER_HOST');
  const user=required(env,'MAIL_ROUTER_USER');
  required(env,'MAIL_ROUTER_PASSWORD',{trim:false});
  const accountId=env.MAIL_ROUTER_ACCOUNT_ID===undefined?'shared':required(env,'MAIL_ROUTER_ACCOUNT_ID');
  const fallback=required(env,'MAIL_ROUTER_FALLBACK_AGENT_ID');
  const namespace=env.MAIL_ROUTER_RECIPIENT_NAMESPACE===undefined?user:required(env,'MAIL_ROUTER_RECIPIENT_NAMESPACE');
  if(env.MAIL_ROUTER_TRUST_RECEIVER!=='true')throw new Error('Mail router: MAIL_ROUTER_TRUST_RECEIVER must explicitly be true for receiver authentication assertions');
  const hasAdvanced=env.MAIL_ROUTER_ROUTES_JSON!==undefined;
  const simpleKeys=['MAIL_ROUTER_RECIPIENT','MAIL_ROUTER_AGENT_ID','MAIL_ROUTER_WHATSAPP_GROUP','MAIL_ROUTER_CHANNEL_ACCOUNT_ID','MAIL_ROUTER_ROUTE_ID'];
  if(hasAdvanced&&simpleKeys.some(key=>env[key]!==undefined))throw new Error('Mail router: choose MAIL_ROUTER_ROUTES_JSON or the single-route environment variables');
  const routes=hasAdvanced?jsonRoutes(env):[{
    id:env.MAIL_ROUTER_ROUTE_ID===undefined?'default':required(env,'MAIL_ROUTER_ROUTE_ID'),accountId,
    recipients:list(env,'MAIL_ROUTER_RECIPIENT'),
    agentId:required(env,'MAIL_ROUTER_AGENT_ID'),
    delivery:{channel:'whatsapp',accountId:env.MAIL_ROUTER_CHANNEL_ACCOUNT_ID===undefined?'default':required(env,'MAIL_ROUTER_CHANNEL_ACCOUNT_ID'),to:required(env,'MAIL_ROUTER_WHATSAPP_GROUP')},
  }];
  const result={
    recipientNamespaces:[namespace],routes,
    accounts:{[accountId]:{
      host,port:integer(env,'MAIL_ROUTER_PORT',993,1,65535),secure:true,
      user:{source:'env',provider:'default',id:'MAIL_ROUTER_USER'},
      password:{source:'env',provider:'default',id:'MAIL_ROUTER_PASSWORD'},
      mailbox:env.MAIL_ROUTER_MAILBOX===undefined?'INBOX':required(env,'MAIL_ROUTER_MAILBOX'),
      agentId:fallback,deliver:false,
      allowedSenders:list(env,'MAIL_ROUTER_ALLOWED_SENDERS'),
      senderAuth:{min:'asserted',acceptTrustedAuthservId:true,trustedAuthservIds:list(env,'MAIL_ROUTER_TRUSTED_AUTHSERV_IDS')},
      watch:{mode:'interval',pollSeconds:integer(env,'MAIL_ROUTER_POLL_SECONDS',60,15,86400)},
      includeBody:true,maxBytes:integer(env,'MAIL_ROUTER_MAX_BYTES',20000,256,1048576),
    }},
  };
  if(env.MAIL_ROUTER_START_FROM!==undefined){
    if(env.MAIL_ROUTER_START_FROM!=='now')throw new Error('Mail router: MAIL_ROUTER_START_FROM must be now or omitted');
    result.startFrom='now';
  }
  validateRouting(result);return result;
}

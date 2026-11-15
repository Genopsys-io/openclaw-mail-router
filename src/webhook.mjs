export function resolveEnv(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      if (!env[name]) throw new Error('Configured environment credential unavailable');
      return env[name];
    });
  }
  if (value?.source === 'env' && typeof value.id === 'string' && env[value.id]) return env[value.id];
  throw new Error('Credential must be a string or an available env reference');
}
export async function dispatch(request, config, {signal, fetchImpl = fetch} = {}) {
  if (!config.hooks?.enabled) throw new Error('Mail webhook is disabled');
  const token = resolveEnv(config.hooks.token);
  if (!token) throw new Error('Mail webhook token unavailable');
  const path = (config.hooks.path || '/hooks').replace(/\/$/, '');
  if (!/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(path)) throw new Error('Invalid hook path');
  const port = config.gateway?.port || 18789;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Gateway port');
  const response = await fetchImpl(`http://127.0.0.1:${port}${path}/agent`, {
    method:'POST',redirect:'error',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':request.idempotencyKey},
    body:JSON.stringify(request),
    signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(210000)]) : AbortSignal.timeout(210000),
  });
  if (!response.ok) throw new Error(`Mail webhook HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok || typeof result.runId !== 'string' || !result.runId) throw new Error('Mail webhook returned no admitted run');
  return result;
}

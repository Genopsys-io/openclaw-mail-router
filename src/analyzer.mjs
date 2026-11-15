const MAX_URLS = 5;
const MAX_ATTACHMENTS = 5;
const ALLOWED_HOSTS = new Set([
  'marches-securises.fr', 'boamp.fr', 'marches-publics.gouv.fr',
  'achatpublic.com', 'aws-achat.info', 'e-marchespublics.com',
]);

export function createAnalyzer(env = process.env, fetchImpl = fetch) {
  const url = env.MAIL_ROUTER_ANALYZER_URL;
  const token = env.MAIL_ROUTER_ANALYZER_TOKEN;
  if (!url && !token) return null;
  if (!url || !token || !/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('Mail analyzer requires URL and token');
  let endpoint;
  try { endpoint = new URL(url); }
  catch (error) {
    if (error instanceof TypeError) throw new Error('Invalid mail analyzer URL');
    throw error;
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.svc.cluster.local') ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/analyze' || endpoint.search || endpoint.hash) {
    throw new Error('Mail analyzer URL must target an internal Kubernetes service');
  }
  return async (mail, {signal} = {}) => {
    const allAttachments = mail.attachments || [];
    const attachments = allAttachments.filter(a =>
      (typeof a.contentType === 'string' && a.contentType.toLowerCase() === 'application/pdf') ||
      (Buffer.isBuffer(a.content) && a.content.subarray(0, 5).equals(Buffer.from('%PDF-'))));
    if (attachments.length > MAX_ATTACHMENTS) throw new Error('Mail analyzer attachment limit exceeded');
    const pdfs = attachments.map(attachment => {
      if (!Buffer.isBuffer(attachment.content)) throw new Error('Mail analyzer PDF content unavailable');
      return {name: (attachment.filename || 'document.pdf').slice(0, 256), data: attachment.content.toString('base64')};
    });
    const source = `${mail.text || ''}\n${typeof mail.html === 'string' ? mail.html.replaceAll('&amp;', '&') : ''}`;
    const candidates = [...new Set((source.match(/https?:\/\/[^\s<>"']+/gi) || []).map(value => value.replace(/[),.;\]]+$/, '')))];
    const urls = candidates.filter(value => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname) &&
          !parsed.username && !parsed.password && !parsed.port;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    });
    if (urls.length > MAX_URLS) throw new Error('Mail analyzer URL limit exceeded');
    const response = await fetchImpl(endpoint, {
      method:'POST', redirect:'error',
      headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      body:JSON.stringify({attachments:pdfs, urls}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`Mail analyzer HTTP ${response.status}`);
    if (!response.body) throw new Error('Mail analyzer returned no response body');
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 256000) throw new Error('Mail analyzer response too large');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('Mail analyzer returned invalid JSON');
      throw error;
    }
    if (!result || !Array.isArray(result.documents) || result.documents.length !== pdfs.length + urls.length ||
        result.documents.some(doc => !doc || typeof doc !== 'object' ||
          (doc.text !== undefined && typeof doc.text !== 'string'))) {
      throw new Error('Mail analyzer returned an invalid response');
    }
    result.unsupportedAttachments = allAttachments.filter(a => !attachments.includes(a))
      .map(a => (a.filename || 'unnamed').slice(0, 256));
    result.skippedUrls = candidates.length - urls.length;
    return result;
  };
}

export function analysisMessage(mail, sender, result, maxBytes) {
  const content = {
    from:sender, subject:mail.subject || '', text:mail.text || '',
    attachments:(mail.attachments || []).map(a => a.filename || 'unnamed'),
    analysis:result, analysisTruncated:false,
  };
  const originalText = content.text;
  const documents = result.documents;
  const originalDocuments = documents.map(doc => typeof doc.text === 'string' ? doc.text : null);
  const originalTruncated = documents.map(doc => doc.truncated);
  const render = limit => {
    content.text = originalText.slice(0, limit);
    documents.forEach((doc, index) => {
      if (originalDocuments[index] !== null) {
        doc.text = originalDocuments[index].slice(0, limit);
        doc.truncated = originalTruncated[index] === true || doc.text.length < originalDocuments[index].length;
      }
    });
    content.analysisTruncated = content.text.length < originalText.length ||
      documents.some((doc, index) => originalDocuments[index] !== null && doc.text.length < originalDocuments[index].length);
    return JSON.stringify(content);
  };
  let low = 0, high = Math.max(originalText.length, ...originalDocuments.map(text => text?.length || 0));
  if (Buffer.byteLength(render(0)) > maxBytes) throw new Error('Mail analyzer metadata exceeds maxBytes');
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return render(low);
}

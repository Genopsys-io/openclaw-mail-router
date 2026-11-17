import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisMessage, createAnalyzer} from '../src/analyzer.mjs';

const env = {MAIL_ROUTER_ANALYZER_URL:'https://analyzer.openclaw-aisa.svc.cluster.local:8080/analyze',MAIL_ROUTER_ANALYZER_TOKEN:'a'.repeat(32)};

test('analyzer is opt-in and accepts only internal service endpoints', () => {
  assert.equal(createAnalyzer({}), null);
  for (const url of ['https://outside.example/analyze', 'http://localhost/analyze', 'http://analyzer.svc.cluster.local/analyze', 'https://analyzer.svc.cluster.local/other']) {
    assert.throws(() => createAnalyzer({...env, MAIL_ROUTER_ANALYZER_URL:url}), /internal Kubernetes/);
  }
  assert.throws(() => createAnalyzer({MAIL_ROUTER_ANALYZER_URL:env.MAIL_ROUTER_ANALYZER_URL}), /requires URL and token/);
});

test('analyzer sends PDF bytes and links, rejects failures and never follows redirects', async () => {
  let request;
  const analyze = createAnalyzer(env, async (url, options) => {
    request = options;
    return new Response(JSON.stringify({documents:[{text:'pdf'},{text:'page'}]}));
  });
  const result = await analyze({
    attachments:[{contentType:'application/pdf',filename:'notice.pdf',content:Buffer.from('%PDF-test')}],
    text:'Voir https://boamp.fr/annonce.', html:'<a href="https://boamp.fr/annonce">offre</a>',
  });
  const data = JSON.parse(request.body);
  assert.equal(Buffer.from(data.attachments[0].data, 'base64').toString(), '%PDF-test');
  assert.deepEqual(data.urls, ['https://boamp.fr/annonce']);
  assert.equal(request.redirect, 'error');
  assert.equal(result.documents.length, 2);
  await assert.rejects(createAnalyzer(env, async () => new Response('', {status:503}))({}), /HTTP 503/);
  await assert.rejects(createAnalyzer(env, async () => new Response('invalid'))({}), /invalid JSON/);
});

test('PDF signature is recognized and unsupported attachments are reported', async () => {
  let request;
  const analyze = createAnalyzer(env, async (_, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({documents:[{text:'pdf'}]}));
  });
  const result = await analyze({attachments:[
    {contentType:'application/octet-stream',filename:'notice.pdf',content:Buffer.from('%PDF-content')},
    {contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',filename:'document.docx',content:Buffer.from('other')},
  ]});
  assert.equal(request.attachments.length, 1);
  assert.deepEqual(result.unsupportedAttachments, ['document.docx']);
});

test('links outside the allowlist are skipped before calling the service', async () => {
  let request;
  const analyze = createAnalyzer(env, async (_, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({documents:[{text:'page'},{text:'www page'}]}));
  });
  const result = await analyze({text:'https://boamp.fr/a https://www.boamp.fr/b https://evil.example/x https://boamp.fr.evil.example/ https://other.boamp.fr/'});
  assert.deepEqual(request.urls, ['https://boamp.fr/a', 'https://www.boamp.fr/b']);
  assert.equal(result.skippedUrls, 3);
});

test('analysis message stays valid JSON within byte budget with explicit truncation', () => {
  const input = {documents:[{source:'attachment', name:'offre.pdf', text:'é'.repeat(5000)}]};
  const output = analysisMessage({text:'é'.repeat(5000),attachments:[]}, 'sender@example.org', input, 512);
  const parsed = JSON.parse(output);
  assert.ok(Buffer.byteLength(output) <= 512);
  assert.equal(parsed.analysisTruncated, true);
  assert.equal(parsed.analysis.documents[0].truncated, true);
  assert.throws(() => analysisMessage({subject:'x'.repeat(500)}, 'sender@example.org', {documents:[]}, 256), /metadata exceeds/);
});

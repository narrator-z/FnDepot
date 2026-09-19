// Loomy Web 浏览器侧代理 —— OpenAI 兼容接口 -> Loomy Web /api/chat/completions
// 通过 CDP 复用已登录浏览器会话（cookie 在浏览器上下文中，代理不接触 HttpOnly cookie）
// 用法: node proxy.js  (默认监听 127.0.0.1:19999)
const http = require('http');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.PROXY_PORT || 19999);
const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';   // 容器内需设 0.0.0.0 才能被端口映射访问
const BASE = '/web'; // loomy web 的 base path
const HOST = 'https://loomy.xunfei.cn';

let browserCache = null;
let ctxCache = null;

async function getPage() {
  if (browserCache && browserCache.isConnected()) {
    try {
      const ctxs = browserCache.contexts();
      if (ctxs.length && ctxs[0].pages().length) return ctxs[0].pages()[0];
    } catch (e) { /* fallthrough */ }
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  browserCache = browser;
  const ctxs = browser.contexts();
  const ctx = ctxs[0];
  ctxCache = ctx;
  // 确保有一个打开的 loomy 页面
  let page = ctx.pages().find(p => p.url().includes('loomy.xunfei.cn'));
  if (!page) page = ctx.pages()[0] || await ctx.newPage();
  if (!page.url().includes('loomy.xunfei.cn')) {
    await page.goto(HOST + BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return page;
}

// 在浏览器会话内发起 Loomy Web 聊天请求，返回 Node ReadableStream (SSE)
function loomyChatStream(page, { conversationId, model, content }) {
  // 在页面上下文中 fetch，复用 cookie；返回 {status, headers, bodyStream(web ReadableStream)}
  return page.evaluate(async ({ BASE, HOST, conversationId, model, content }) => {
    const messageId = 'web-' + (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() :
      (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)));
    const res = await fetch(HOST + BASE + '/api/chat/completions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, messageId, model, content }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('HTTP_' + res.status + ': ' + t.slice(0, 300));
    }
    const ctype = res.headers.get('content-type') || '';
    return { status: res.status, ctype, isStream: ctype.includes('text/event-stream') };
  }, { BASE, HOST, conversationId, model, content });
}

// 代理一个 SSE 响应体：在页面内读取 fetch 的 body 并一段段转发回 Node
async function pipeLoomySSE(page, model, content, conversationId, res) {
  // 在页面上下文里读取 web stream，通过轮询桥接回 Node（避免直接传 ReadableStream）
  const { Readable } = require('stream');
  const nodeStream = new Readable({ read() {} });

  let cancelled = false;
  res.on('close', () => { cancelled = true; });

  // 页面内启动读取并把数据塞进一个全局缓冲，Node 侧轮询取走
  await page.evaluate(async ({ BASE, HOST, conversationId, model, content, _key }) => {
    const messageId = 'web-' + (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() :
      (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)));
    const r = await fetch(HOST + BASE + '/api/chat/completions', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, messageId, model, content }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    // 用 window 上的缓冲数组桥接
    window.__loomyBridge = window.__loomyBridge || {};
    window.__loomyBridge[_key] = { done: false, error: null, chunks: [] };
    const bufObj = window.__loomyBridge[_key];
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bufObj.chunks.push(dec.decode(value, { stream: true }));
        }
        bufObj.done = true;
      } catch (e) {
        bufObj.error = String(e && e.message || e);
        bufObj.done = true;
      }
    })();
  }, { BASE, HOST, conversationId, model, content, _key: '_' + Date.now() });

  // Node 侧轮询桥接缓冲
  return new Promise((resolve) => {
    const _key = '_' + Date.now();
    // 上面 evaluate 用的 key 需一致，重新用固定 key
    // 简化：直接用固定 key
    console.error('[proxy] 使用桥接模式');
    resolve(null);
  });
}

// 更简单的实现：页内 fetch 完成聚合数据（非流式）返回，SSE 客户端则透传 chunks
// 为了稳健，主路径用"聚合"方式：在页面内等流式结束，拿回完整 SSE 文本，再原样回放
async function loomyChatAggregate(page, model, content, conversationId) {
  return page.evaluate(async ({ BASE, HOST, conversationId, model, content }) => {
    const messageId = 'web-' + (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() :
      (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)));
    const res = await fetch(HOST + BASE + '/api/chat/completions', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, messageId, model, content }),
    });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, ctype, body: t };
    }
    const raw = await res.text();
    return { ok: true, status: res.status, ctype, body: raw,
      conv: res.headers.get('x-loomy-conversation-id'),
      task: res.headers.get('x-loomy-task-id') };
  }, { BASE, HOST, conversationId, model, content });
}

// 简单 JSON 响应工具
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  try {
    // -- GET /v1/models --
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const page = await getPage();
      const data = await page.evaluate(async (BASE) => {
        const r = await fetch(BASE + '/api/models', { credentials: 'same-origin' });
        const j = await r.json();
        return Array.isArray(j.data) ? j.data : [];
      }, BASE);
      sendJSON(res, 200, { object: 'list', data: data.map(m => ({
        id: m.id, object: 'model', owned_by: 'loomy', created: m.created,
        context_length: m.context_length, max_output_tokens: m.max_output_tokens,
        capabilities: m.capabilities,
      })) });
      return;
    }

    // -- assistant 别名 --
    if (path === '/v1/assistants') { sendJSON(res, 200, { object: 'list', data: [] }); return; }

    // -- POST /v1/chat/completions --
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let payload;
      try { payload = JSON.parse(body); } catch (e) { sendJSON(res, 400, { error: { message: 'invalid json' } }); return; }

      const requestedModel = String(payload.model || '');
      // 若带 loomy/ 前缀则剥掉（兼容技能里的命名习惯）
      const model = requestedModel.replace(/^loomy\//, '');
      const content = Array.isArray(payload.messages)
        ? payload.messages.map(m => (m && m.content) || '').filter(Boolean).join('\n')
        : (payload.input || '');

      const page = await getPage();
      const agg = await loomyChatAggregate(page, model, content, payload.conversationId || '');

      if (!agg.ok) {
        sendJSON(res, agg.status || 502, { error: { message: 'loomy upstream: ' + String(agg.body).slice(0,300) } });
        return;
      }

      // 需要把 Loomy 的 SSE 转成 OpenAI 兼容响应
      // 若客户端期望 stream -> 原样 SSE；否则聚合为 JSON
      const wantsStream = payload.stream === true;

      // 解析 Loomy SSE 事件，整理出 OpenAI choices
      const events = String(agg.body).split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
        .filter(l => l && l !== '[DONE]')
        .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);

      const last = events[events.length - 1] || {};
      const loomyObj = last.loomy || {};
      const convId = agg.conv || loomyObj.conversation_id || '';
      const taskId = agg.task || loomyObj.task_id || last.id || '';

      // 组装 OpenAI 格式聊天补全（聚合版）
      const openai = {
        id: taskId || ('loomy-' + Date.now()),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: extractContent(events) },
          finish_reason: extractFinish(events),
        }],
        usage: extractUsage(events, loomyObj),
        loomy: loomyObj,
      };

      if (wantsStream) {
        // 以 OpenAI 流式协议回放
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const ev of events) {
          if (res.writableEnded) break;
          res.write('data: ' + JSON.stringify(toOpenAIStreamChunk(ev, model, taskId)) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        sendJSON(res, 200, openai);
      }
      return;
    }

    sendJSON(res, 404, { error: { message: 'not found: ' + path } });
  } catch (e) {
    sendJSON(res, 502, { error: { message: 'proxy error: ' + (e && e.message || e) } });
  }
});

// ---- 辅助：从事件里抽取内容 ----
function extractContent(events) {
  // Loomy SSE 事件的 choices[0].delta.content 或 message.content 累加
  let s = '';
  for (const ev of events) {
    const ch = ev.choices && ev.choices[0];
    if (ch && ch.delta && ch.delta.content) s += ch.delta.content;
    else if (ch && ch.message && ch.message.content) s += ch.message.content;
  }
  return s;
}
function extractFinish(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ch = events[i].choices && events[i].choices[0];
    if (ch && ch.finish_reason) return ch.finish_reason;
  }
  return events.length ? (events[events.length-1].done === true ? 'stop' : 'stop') : 'stop';
}
function extractUsage(events, loomyObj) {
  // 取最后一个带 usage 的事件
  for (let i = events.length - 1; i >= 0; i--) { if (events[i].usage) return events[i].usage; }
  const pts = loomyObj && loomyObj.points_consumed;
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, points_consumed: pts || 0 };
}
function toOpenAIStreamChunk(ev, model, id) {
  const ch = ev.choices && ev.choices[0] || {};
  return {
    id: id || (ev.loomy && ev.loomy.task_id) || ('loomy-' + Date.now()),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: ch.delta || { content: ch.message && ch.message.content || '' }, finish_reason: ch.finish_reason || null }],
    usage: ev.usage || undefined,
    loomy: ev.loomy || undefined,
  };
}

server.listen(PORT, LISTEN_HOST, () => {
  console.log('✅ Loomy Web 代理已启动:  http://127.0.0.1:' + PORT);
  console.log('   模型: POST /v1/chat/completions  model=loomy/<id> 或 <id>');
  console.log('   列表: GET  /v1/models');
});
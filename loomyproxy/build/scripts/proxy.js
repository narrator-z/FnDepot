// Loomy Web 浏览器侧代理 —— OpenAI 兼容接口 -> Loomy Web /api/chat/completions
// 通过 CDP 复用已登录浏览器会话（cookie 在浏览器上下文中，代理不接触 HttpOnly cookie）
//
// 1.1.0 变更：
//   1) 真流式：页内 fetch 边读边把 chunk 推进 window.__loomyBridge[reqId]，Node 侧按轮询增量拉取
//      并即时写回客户端；不再是「等整段 SSE 生成完再一次性回放」（1.0.x 的 pipeLoomySSE 是未完成的
//      死代码，实际走 loomyChatAggregate 整段 await，TTFT 等于完整生成耗时）。
//   2) 并发控制：LOOMY_MAX_IN_FLIGHT 限流 + 单请求超时 + 客户端断开即 AbortController 中止。
//   3) 每请求独立 reqId 作为页面侧 key，彻底消除多请求共用全局缓冲导致的响应串扰。
//   4) /v1/models 加 TTL 缓存。
//   5) 结构化访问日志：ts | method | path | model | status | ms | bytes。
const http = require('http');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.PROXY_PORT || 19999);
const LISTEN_HOST = process.env.PROXY_HOST || '127.0.0.1';   // 容器内需设 0.0.0.0 才能被端口映射访问
const BASE = '/web'; // loomy web 的 base path
const HOST = 'https://loomy.xunfei.cn';

// 同时在途的 Loomy 会话数。数据已按 reqId 隔离，这里主要限制上游并发。
// 默认 2 是权衡：既避免队头阻塞（一个长回答把后续请求全堵死），又不至于打爆上游。
const MAX_IN_FLIGHT = Math.max(1, Number(process.env.LOOMY_MAX_IN_FLIGHT || 2));
// 单请求总超时（长回答可能数十秒，故默认 120s）
const REQ_TIMEOUT_MS = Number(process.env.LOOMY_REQ_TIMEOUT_MS || 120000);
// Node 侧从页面缓冲拉取增量的间隔
const POLL_MS = Number(process.env.LOOMY_STREAM_POLL_MS || 80);
// 启动页内 fetch 的超时（只是发起请求，不含生成过程）
const START_TIMEOUT_MS = Number(process.env.LOOMY_START_TIMEOUT_MS || 30000);
// /v1/models 缓存时长
const MODELS_TTL_MS = Number(process.env.LOOMY_MODELS_TTL_MS || 300000);

let browserCache = null;

// ---------- 浏览器会话 ----------
async function getPage() {
  if (browserCache && browserCache.isConnected()) {
    try {
      const ctxs = browserCache.contexts();
      if (ctxs.length && ctxs[0].pages().length) return ctxs[0].pages()[0];
    } catch (e) { /* fallthrough */ }
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  browserCache = browser;
  const ctx = browser.contexts()[0];
  // 确保有一个打开的 loomy 页面
  let page = ctx.pages().find(p => p.url().includes('loomy.xunfei.cn'));
  if (!page) page = ctx.pages()[0] || await ctx.newPage();
  if (!page.url().includes('loomy.xunfei.cn')) {
    await page.goto(HOST + BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return page;
}

// ---------- 并发限流 ----------
let inFlight = 0;
const waiters = [];
function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve(); }
  return new Promise(resolve => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) { next(); } else { inFlight--; }
}

// ---------- 工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT:' + label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function logLine(method, path, model, status, ms, bytes) {
  console.log([new Date().toISOString(), method, path, model, status, ms + 'ms', bytes + 'B'].join(' | '));
}

// ---------- 页面侧：启动 / 拉取 / 中止 / 清理 ----------
// 发起流式请求后立即返回；数据在页面上下文内异步累积到 window.__loomyBridge[reqId]
function startChat(page, reqId, { model, content, conversationId }) {
  return page.evaluate(async ({ BASE, HOST, model, content, conversationId, reqId }) => {
    const w = window;
    w.__loomyBridge = w.__loomyBridge || {};
    w.__loomyAbort = w.__loomyAbort || {};
    const ac = new AbortController();
    w.__loomyAbort[reqId] = ac;
    const buf = { chunks: [], done: false, error: null, status: 0 };
    w.__loomyBridge[reqId] = buf;
    (async () => {
      try {
        const res = await fetch(HOST + BASE + '/api/chat/completions', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, messageId: 'web-' + reqId, model, content }),
          signal: ac.signal,
        });
        buf.status = res.status;
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          buf.error = 'HTTP_' + res.status + ': ' + String(t).slice(0, 300);
          buf.done = true;
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf.chunks.push(dec.decode(value, { stream: true }));
        }
        buf.done = true;
      } catch (e) {
        buf.error = String((e && e.message) || e);
        buf.done = true;
      } finally {
        delete w.__loomyAbort[reqId];
      }
    })();
  }, { BASE, HOST, model, content, conversationId, reqId });
}

// 取走增量（splice 保证不重复消费）
function pollChat(page, reqId) {
  return page.evaluate((reqId) => {
    const b = window.__loomyBridge && window.__loomyBridge[reqId];
    if (!b) return { chunks: [], done: true, error: 'NO_BUFFER', status: 0 };
    const chunks = b.chunks.splice(0, b.chunks.length);
    return { chunks, done: b.done, error: b.error, status: b.status };
  }, reqId);
}

// 客户端断开 / 超时时中止页内 fetch，避免上游继续生成白白消耗额度
function abortChat(page, reqId) {
  return page.evaluate((reqId) => {
    const ac = window.__loomyAbort && window.__loomyAbort[reqId];
    if (ac) ac.abort();
  }, reqId).catch(() => {});
}

// 必须清理，否则 window.__loomyBridge 会随请求数无限增长（内存泄漏）
function cleanupChat(page, reqId) {
  return page.evaluate((reqId) => {
    if (window.__loomyBridge) delete window.__loomyBridge[reqId];
    if (window.__loomyAbort) delete window.__loomyAbort[reqId];
  }, reqId).catch(() => {});
}

// 完整跑一次对话：轮询增量 -> onText 回调 -> 返回聚合文本
// shouldStop() 返回 true 时立即停止（客户端断开或超时）
async function runChat(page, { model, content, conversationId, onText, shouldStop }) {
  const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const startAt = Date.now();
  let raw = '';
  let stopped = false;
  let lastStatus = 0;
  let lastError = null;
  try {
    await withTimeout(startChat(page, reqId, { model, content, conversationId }), START_TIMEOUT_MS, 'start');
    for (;;) {
      if (shouldStop && shouldStop()) { stopped = true; break; }
      await sleep(POLL_MS);
      const r = await withTimeout(pollChat(page, reqId), 15000, 'poll');
      if (r.chunks && r.chunks.length) {
        for (const c of r.chunks) {
          raw += c;
          if (onText) onText(c);
        }
      }
      if (r.status) lastStatus = r.status;
      if (r.done) { lastError = r.error; break; }
      if (Date.now() - startAt > REQ_TIMEOUT_MS) { stopped = true; lastError = 'TIMEOUT'; break; }
    }
  } finally {
    if (stopped) await abortChat(page, reqId);
    await cleanupChat(page, reqId);
  }
  return { raw, error: lastError, status: lastStatus, timedOut: stopped };
}

// ---------- 响应工具 ----------
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
  return Buffer.byteLength(s);
}

// SSE 增量解析：不完整的行留在 pending 里，等下一段数据补齐
function makeSSEProcessor(onEvent) {
  let pending = '';
  const handle = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(payload); } catch (e) { return; }
    onEvent(ev);
  };
  return {
    push(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) handle(line);
    },
    flush() {
      const rest = pending;
      pending = '';
      if (rest.trim()) handle(rest);
    },
  };
}

function extractContent(events) {
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
  return 'stop';
}
function extractUsage(events, loomyObj) {
  // 取最后一个带 usage 的事件
  for (let i = events.length - 1; i >= 0; i--) { if (events[i].usage) return events[i].usage; }
  const pts = loomyObj && loomyObj.points_consumed;
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, points_consumed: pts || 0 };
}
function toOpenAIStreamChunk(ev, model, id) {
  const ch = (ev.choices && ev.choices[0]) || {};
  return {
    id: id || (ev.loomy && ev.loomy.task_id) || ('loomy-' + Date.now()),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: ch.delta || { content: (ch.message && ch.message.content) || '' },
      finish_reason: ch.finish_reason || null,
    }],
    usage: ev.usage || undefined,
    loomy: ev.loomy || undefined,
  };
}

// ---------- /v1/models 缓存 ----------
let modelsCache = { at: 0, data: null };
async function fetchModels(page) {
  const now = Date.now();
  if (modelsCache.data && (now - modelsCache.at) < MODELS_TTL_MS) {
    return { data: modelsCache.data, cached: true };
  }
  const data = await page.evaluate(async (BASE) => {
    const r = await fetch(BASE + '/api/models', { credentials: 'same-origin' });
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : [];
  }, BASE);
  modelsCache = { at: now, data };
  return { data, cached: false };
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const startAt = Date.now();
  let modelLogged = '-';

  const done = (status, bytes) => logLine(req.method, path, modelLogged, status, Date.now() - startAt, bytes || 0);

  try {
    // -- GET /v1/models --
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const page = await getPage();
      const { data } = await fetchModels(page);
      const n = sendJSON(res, 200, { object: 'list', data: data.map(m => ({
        id: m.id, object: 'model', owned_by: 'loomy', created: m.created,
        context_length: m.context_length, max_output_tokens: m.max_output_tokens,
        capabilities: m.capabilities,
      })) });
      done(200, n);
      return;
    }

    // -- assistant 别名 --
    if (path === '/v1/assistants') { const n = sendJSON(res, 200, { object: 'list', data: [] }); done(200, n); return; }

    // -- POST /v1/chat/completions --
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      let body = '';
      for await (const c of req) body += c;
      let payload;
      try { payload = JSON.parse(body); }
      catch (e) { const n = sendJSON(res, 400, { error: { message: 'invalid json' } }); done(400, n); return; }

      const requestedModel = String(payload.model || '');
      // 若带 loomy/ 前缀则剥掉（兼容技能里的命名习惯）
      const model = requestedModel.replace(/^loomy\//, '');
      modelLogged = model || '-';
      const content = Array.isArray(payload.messages)
        ? payload.messages.map(m => (m && m.content) || '').filter(Boolean).join('\n')
        : (payload.input || '');
      const wantsStream = payload.stream === true;

      await acquire();
      let bytesOut = 0;
      let clientGone = false;
      let sseStarted = false;
      try {
        const page = await getPage();
        res.on('close', () => { clientGone = true; });
        const shouldStop = () => clientGone || res.writableEnded;

        const events = [];
        let lastEv = null;
        let taskId = '';

        const writeSSE = (obj) => {
          const s = 'data: ' + JSON.stringify(obj) + '\n\n';
          bytesOut += Buffer.byteLength(s);
          res.write(s);
        };
        const startSSE = () => {
          if (sseStarted) return;
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
          sseStarted = true;
        };
        const onEvent = (ev) => {
          events.push(ev);
          lastEv = ev;
          const loomyObj = ev.loomy || {};
          if (!taskId) taskId = loomyObj.task_id || ev.id || '';
          if (wantsStream && !res.writableEnded) { startSSE(); writeSSE(toOpenAIStreamChunk(ev, model, taskId)); }
        };

        const processor = makeSSEProcessor(onEvent);
        const result = await runChat(page, {
          model,
          content,
          conversationId: payload.conversationId || '',
          onText: (t) => processor.push(t),
          shouldStop,
        });
        processor.flush();

        // 上游错误 / 超时
        if (result.error || result.timedOut) {
          if (clientGone) { done(499, bytesOut); if (!res.writableEnded) res.end(); return; }
          let code = 502;
          let msg = 'loomy upstream: ' + String(result.error || '').slice(0, 300);
          if (result.timedOut && result.error === 'TIMEOUT') { code = 504; msg = 'loomy upstream timeout (> ' + REQ_TIMEOUT_MS + 'ms)'; }
          if (sseStarted) {
            // 流已开始，无法再改状态码，补一个错误事件后收尾
            const errChunk = 'data: ' + JSON.stringify({ error: { message: msg } }) + '\n\n';
            bytesOut += Buffer.byteLength(errChunk);
            res.write(errChunk);
            res.write('data: [DONE]\n\n');
            res.end();
            done(code, bytesOut);
            return;
          }
          const n = sendJSON(res, code, { error: { message: msg } });
          done(code, n);
          return;
        }
        if (clientGone) { done(499, bytesOut); if (!res.writableEnded) res.end(); return; }

        const loomyObj = (lastEv && lastEv.loomy) || {};
        const finalTaskId = taskId || loomyObj.task_id || (lastEv && lastEv.id) || '';

        if (wantsStream) {
          startSSE();
          // OpenAI 协议的结束标记是字面量 data: [DONE]，不是 JSON 字符串
          res.write('data: [DONE]\n\n');
          res.end();
          done(200, bytesOut);
          return;
        }

        const n = sendJSON(res, 200, {
          id: finalTaskId || ('loomy-' + Date.now()),
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
        });
        done(200, n);
        return;
      } finally {
        release();
      }
    }

    const n = sendJSON(res, 404, { error: { message: 'not found: ' + path } });
    done(404, n);
  } catch (e) {
    try {
      const n = sendJSON(res, 502, { error: { message: 'proxy error: ' + (e && e.message || e) } });
      logLine(req.method, path, modelLogged, 502, Date.now() - startAt, n);
    } catch (_) { /* 连接已断开，忽略 */ }
  }
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log('✅ Loomy Web 代理已启动:  http://' + LISTEN_HOST + ':' + PORT);
  console.log('   模型: POST /v1/chat/completions  model=loomy/<id> 或 <id>');
  console.log('   列表: GET  /v1/models');
  console.log('   配置: MAX_IN_FLIGHT=' + MAX_IN_FLIGHT + ' REQ_TIMEOUT=' + REQ_TIMEOUT_MS + 'ms POLL=' + POLL_MS + 'ms MODELS_TTL=' + MODELS_TTL_MS + 'ms');
});

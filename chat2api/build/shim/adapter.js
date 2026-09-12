/**
 * Chat2API fnOS 核心适配器（由 build/build-inner.sh 复制到 app/server/core/adapter.js）
 *
 * 位置：server-entry.js 发现 core/index.js 存在时，会把 /api/* 和 /v1/* 转交到这里。
 *
 *   管理界面（Unix Socket，飞牛统一网关 /app/chat2api）
 *     POST /api/ipc        —— 把前端的 ipcRenderer.invoke 分发到 ipcMain 注册表
 *     POST /api/ipc/send   —— fire-and-forget 型
 *     GET  /api/events     —— SSE，把 webContents.send 的事件广播给浏览器
 *     ↓
 *   OpenAI 兼容 API（TCP 26800）
 *     /v1/*                —— 原样交给 Koa 的 callback，流式响应必须直通
 *
 * 设计原则：
 *   1) 懒初始化。第一次请求到来时才 boot 主进程代码，boot 失败不能让服务起不来 ——
 *      返回明确的 JSON 错误，用户至少能看到原因，而不是白屏或 502。
 *   2) 不吞异常。任何 handler 抛错都要变成 { ok:false, error } 给前端，
 *      前端能提示，而不是一直 loading。
 */

'use strict';

const path = require('path');

// ------------------------------------------------------------------ 引导

let bootPromise = null;
let bootError = null;

/**
 * 找主进程入口模块。
 *
 * 不能写死文件名：rollup 的入口 key（fnos / fnos-entry / index）由 build-inner.sh
 * 里的 vite 配置决定，改名后这里硬编码就会找不到，症状是「未找到主进程产物」
 * 但实际文件就在旁边。所以改为扫描 core/raw/ 下的 js，探测哪个导出了
 * dispatchIpc —— 以能力为准，不以名字为准。
 */
function locateEntry() {
  const fs = require('fs');
  const rawDir = path.join(__dirname, 'raw');
  const dirs = [rawDir, __dirname];

  const failures = [];

  for (const dir of dirs) {
    let files = [];
    try {
      if (!fs.existsSync(dir)) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));
    } catch (e) {
      failures.push(dir + ' (readdir): ' + (e && e.message ? e.message : e));
      continue;
    }

    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const mod = require(full);
        const candidate = pickExport(mod, 'dispatchIpc');
        if (typeof candidate === 'function') return full;
        // 能 require 但没有 dispatchIpc：可能只是被别的 chunk 依赖的片段，不算硬失败
      } catch (e) {
        // 记录失败原因：真正的入口 require 失败（例如缺模块）必须让调用方看到，
        // 而不是被静默吞掉后误报「未找到主进程产物」。
        failures.push(full + ': ' + (e && e.message ? e.message : e));
      }
    }
  }

  // 扫描完全部落空：抛出真实原因，绝不静默返回 null。
  throw new Error(
    '未找到可用的主进程入口（core/raw 下 require 均失败）: ' +
    (failures.length ? failures.join(' | ') : '目录下没有 .js/.cjs 文件')
  );
}

/**
 * 兼容不同打包方式的导出：
 *   CJS 直接导出、或挂在 default / exports 上。
 */
function pickExport(mod, name) {
  if (!mod) return undefined;
  if (typeof mod[name] === 'function') return mod[name];
  if (mod.default && typeof mod.default[name] === 'function') return mod.default[name];
  return undefined;
}

const api = {
  init: null,
  dispatchIpc: null,
  dispatchIpcSend: null,
  subscribeEvents: null,
  getApiCallback: null,
  getDiagnostics: null,
  koaCallback: null
};

async function boot() {
  // locateEntry() 失败时会直接 throw（含每个候选的真实 require 失败原因），
  // 这里不再包一层误导性的「构建产物不完整」文案。
  const entryPath = locateEntry();

  console.log('[chat2api] loading core from ' + entryPath);
  const mod = require(entryPath);

  api.init = pickExport(mod, 'init');
  api.dispatchIpc = pickExport(mod, 'dispatchIpc');
  api.dispatchIpcSend = pickExport(mod, 'dispatchIpcSend');
  api.subscribeEvents = pickExport(mod, 'subscribeEvents');
  api.getApiCallback = pickExport(mod, 'getApiCallback');
  api.getDiagnostics = pickExport(mod, 'getDiagnostics');

  if (!api.init || !api.dispatchIpc) {
    throw new Error('主进程入口缺少 init/dispatchIpc 导出，实际导出: ' +
      Object.keys(mod).join(','));
  }

  const dataDir = process.env.CHAT2API_DATA_DIR || process.env.DATA_DIR || undefined;
  await api.init({ dataDir: dataDir });

  if (typeof api.getApiCallback === 'function') {
    const cb = api.getApiCallback();
    if (typeof cb === 'function') api.koaCallback = cb;
    else console.warn('[chat2api] getApiCallback() 未返回函数，/v1/* 将不可用');
  }

  console.log('[chat2api] core ready');
}

function ensureBoot() {
  if (!bootPromise) {
    bootPromise = boot().catch((err) => {
      bootError = err;
      // 允许下次请求重试：核心初始化失败往往是数据目录/依赖问题，
      // 用户修好后重启进程即可，不必让一次失败永久钉死。
      bootPromise = null;
      console.error('[chat2api] core 初始化失败:', err && err.stack ? err.stack : err);
      throw err;
    });
  }
  return bootPromise;
}

// ------------------------------------------------------------------ 工具

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bootFailedPayload() {
  return {
    ok: false,
    error: 'core_not_ready',
    message: bootError
      ? String(bootError.message || bootError)
      : 'Chat2API 核心尚未就绪'
  };
}

// ------------------------------------------------------------------ 管理侧

/** SSE：把主进程的 webContents.send 事件推给浏览器 */
function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 反向代理（飞牛网关）不要缓冲 SSE
    'X-Accel-Buffering': 'no'
  });
  res.write(': stream opened\n\n');

  let unsubscribe = null;
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      /* 连接已断，下面的 close 处理会清理 */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(ping);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (e) {
        /* ignore */
      }
      unsubscribe = null;
    }
  };

  if (typeof api.subscribeEvents === 'function') {
    unsubscribe = api.subscribeEvents((evt) => {
      try {
        res.write('data: ' + JSON.stringify(evt) + '\n\n');
      } catch (e) {
        cleanup();
      }
    });
  } else {
    console.warn('[chat2api] 主进程未导出 subscribeEvents，事件推送不可用');
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function handleIpc(req, res, ctx, fireAndForget) {
  let raw;
  try {
    raw = await readBody(req, 4 * 1024 * 1024);
  } catch (e) {
    return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: 'invalid_json' });
  }

  const channel = payload.channel;
  const args = Array.isArray(payload.args) ? payload.args : [];

  if (typeof channel !== 'string' || !channel) {
    return sendJson(res, 400, { ok: false, error: 'missing_channel' });
  }

  try {
    if (fireAndForget) {
      if (typeof api.dispatchIpcSend === 'function') api.dispatchIpcSend(channel, args);
      return sendJson(res, 200, { ok: true });
    }

    const result = await api.dispatchIpc(channel, args);
    return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // handler 未注册是最常见的情况，单列出来便于定位是哪个 channel 漏了
    if (/not found/i.test(message)) {
      console.warn('[chat2api] ipc channel 未注册: ' + channel);
      return sendJson(res, 404, { ok: false, error: 'channel_not_found', message: message });
    }
    console.error('[chat2api] ipc ' + channel + ' 执行失败: ' + message);
    return sendJson(res, 200, { ok: false, error: 'handler_error', message: message });
  }
}

async function handleManagement(req, res, ctx) {
  const pathname = ctx.pathname;

  try {
    await ensureBoot();
  } catch (e) {
    return sendJson(res, 503, bootFailedPayload());
  }

  if (pathname === '/api/events') {
    return handleEvents(req, res);
  }
  if (pathname === '/api/ipc/send') {
    return handleIpc(req, res, ctx, true);
  }
  if (pathname === '/api/ipc') {
    return handleIpc(req, res, ctx, false);
  }
  if (pathname === '/api/diagnostics') {
    let diag = {};
    try {
      if (typeof api.getDiagnostics === 'function') diag = api.getDiagnostics() || {};
    } catch (e) {
      diag = { error: String(e && e.message ? e.message : e) };
    }
    return sendJson(res, 200, { ok: true, diagnostics: diag });
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'not_found',
    message: '未知的管理接口: ' + pathname
  });
}

// ------------------------------------------------------------------ API 侧

/**
 * OpenAI 兼容 /v1/* —— 交给 Koa。
 * 注意：绝对不要在这里预读 body。Koa / 上游代理需要原始流来支持 SSE 流式响应，
 * 一旦读过 req，流式输出就被破坏（客户端会等到全部结束才收到数据）。
 */
async function handleApi(req, res, ctx) {
  try {
    await ensureBoot();
  } catch (e) {
    const body = JSON.stringify({
      error: {
        message: 'Chat2API 核心尚未就绪：' +
          (bootError ? String(bootError.message || bootError) : '未知原因'),
        type: 'server_error'
      }
    });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    return res.end(body);
  }

  if (!api.koaCallback) {
    const body = JSON.stringify({
      error: { message: 'OpenAI 代理未初始化（Koa callback 缺失）', type: 'server_error' }
    });
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    return res.end(body);
  }

  return api.koaCallback(req, res);
}

module.exports = {
  handleManagement: handleManagement,
  handleApi: handleApi
};

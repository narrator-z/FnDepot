#!/usr/bin/env node
'use strict';

/**
 * Chat2API fnOS 服务端入口
 *
 * 同时提供两个监听器：
 *   1) Unix Socket（SOCKET_PATH）—— 管理界面，由飞牛统一网关挂到 /app/chat2api。
 *      网关已代为校验 NAS 登录态，并转发 X-Trim-Userid / X-Trim-Isadmin / X-Trim-Username。
 *      不占 TCP 端口，从根本上避开端口冲突。
 *   2) TCP（API_PORT，默认 26800）—— OpenAI 兼容 API 代理，供 Cline / Cherry Studio
 *      等外部客户端调用。这类客户端必须走 IP+端口，无法走需要登录态的网关。
 *
 * 渐进接入：
 *   若 app/server/core/index.js 存在（由 build/build-server.sh 从 Chat2API-WXS 构建产出），
 *   则把 HTTP 请求转交它处理；否则使用内置的占位实现。
 *   因此本骨架可以先打包、先装到 NAS 上验证「网关 + 端口 + 生命周期」整条通路，
 *   再逐步替换成真实业务逻辑，两边互不阻塞。
 *
 * 兼容 Node.js 18+（不使用 toReversed / Array.prototype.at 等较新 API）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = '1.6.5';
const APP_NAME = 'chat2api';

const SOCKET_PATH = process.env.SOCKET_PATH || path.join(process.cwd(), 'app.sock');
const API_PORT = Number.parseInt(process.env.API_PORT || '26800', 10);
const API_HOST = process.env.API_HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');
const DATA_DIR =
  process.env.CHAT2API_DATA_DIR ||
  process.env.DATA_DIR ||
  path.join(__dirname, '..', 'data');
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '/app/chat2api';
// 飞牛把安装向导字段以「字段名」注入环境变量，故两种写法都读
const ADMIN_KEY = process.env.CHAT2API_ADMIN_KEY || process.env.chat2api_admin_key || '';

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ---------- 真实核心（若已构建）----------
let core = null;
const CORE_PATH = path.join(__dirname, 'core', 'index.js');
if (fs.existsSync(CORE_PATH)) {
  try {
    core = require(CORE_PATH);
    log('Chat2API core loaded from ' + CORE_PATH);
  } catch (err) {
    log('WARN: core 加载失败，回退占位实现: ' + (err && err.message ? err.message : err));
    core = null;
  }
} else {
  log('core 未接入（' + CORE_PATH + ' 不存在），使用占位实现');
}

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

/** 把 URL 路径安全地限制在 root 目录内，防目录穿越。 */
function safeJoin(root, urlPath) {
  const normalized = path.posix.normalize(urlPath);
  const resolved = path.resolve(root, '.' + normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendText(res, 404, 'Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // 带 hash 的构建产物可长缓存，其余一律不缓存，避免升级后页面还是旧的
      'Cache-Control': /-[A-Za-z0-9_]{8,}\./.test(path.basename(filePath))
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
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

function getGatewayUser(req) {
  return {
    uid: req.headers['x-trim-userid'] || null,
    isAdmin: req.headers['x-trim-isadmin'] === 'true',
    username: req.headers['x-trim-username'] || null
  };
}

/** 剥离统一网关前缀；非前缀开头的请求也放行，便于容器/直连调试。 */
function stripPrefix(pathname) {
  if (pathname === GATEWAY_PREFIX) return '/';
  if (pathname.startsWith(GATEWAY_PREFIX + '/')) {
    return pathname.slice(GATEWAY_PREFIX.length) || '/';
  }
  return pathname;
}

function parsePath(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    return '/';
  }
}

// ---------- 管理界面（Unix Socket）----------
function mgmtHandler(req, res) {
  const pathname = stripPrefix(parsePath(req));
  const user = getGatewayUser(req);

  // 状态接口：前端与运维都用它做健康检查
  if (pathname === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      app: APP_NAME,
      version: VERSION,
      coreReady: !!core,
      transport: 'unix-socket',
      socket: SOCKET_PATH,
      gatewayPrefix: GATEWAY_PREFIX,
      apiPort: API_PORT,
      adminKeyEnabled: !!ADMIN_KEY,
      dataDir: DATA_DIR,
      staticDir: STATIC_DIR,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      gatewayUser: user
    });
  }

  // 已接入真实核心时，业务 API 交给它处理
  if (core && typeof core.handleManagement === 'function') {
    if (pathname.startsWith('/api/')) {
      return core.handleManagement(req, res, { pathname, user, sendJson, readBody });
    }
  } else if (pathname.startsWith('/api/')) {
    return sendJson(res, 503, {
      error: 'core_not_ready',
      message: 'Chat2API 核心尚未接入，当前为骨架占位实现。'
    });
  }

  // 静态资源：命中文件则直接返回，否则回退 index.html（React SPA 路由）
  const candidate = safeJoin(STATIC_DIR, pathname);
  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(res, candidate);
  }
  const indexHtml = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return sendFile(res, indexHtml);
  }
  return sendText(res, 404, 'Not Found: ' + pathname);
}

// ---------- OpenAI 兼容 API（TCP 26800）----------
function checkApiKey(req) {
  if (!ADMIN_KEY) return true;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === ADMIN_KEY;
}

function apiHandler(req, res) {
  const pathname = parsePath(req);

  if (pathname === '/health' || pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, app: APP_NAME, version: VERSION, coreReady: !!core });
  }

  if (!checkApiKey(req)) {
    return sendJson(res, 401, {
      error: { message: 'Unauthorized: 无效的 API Key', type: 'invalid_request_error' }
    });
  }

  if (core && typeof core.handleApi === 'function') {
    return core.handleApi(req, res, { pathname, sendJson, readBody });
  }

  // 占位实现：让客户端能连通并看到明确的「尚未接入」提示，而不是连接被拒
  if (pathname === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: [] });
  }
  if (pathname.indexOf('/v1/') === 0) {
    return sendJson(res, 503, {
      error: {
        message:
          'Chat2API 核心尚未接入（当前为骨架占位实现）。请执行 build/build-server.sh 构建 Chat2API-WXS 后重新打包。',
        type: 'server_error'
      }
    });
  }
  return sendJson(res, 404, { error: { message: 'Not Found: ' + pathname, type: 'invalid_request_error' } });
}

// ---------- 启动 ----------
function cleanupAndExit(code) {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (e) {
    /* ignore */
  }
  process.exit(code);
}

function bootstrap() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    log('WARN: 无法创建数据目录 ' + DATA_DIR + ': ' + e.message);
  }

  // 1) 管理界面：Unix Socket
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (e) {
    log('WARN: 清理旧 socket 失败: ' + e.message);
  }

  const mgmtServer = http.createServer(mgmtHandler);
  mgmtServer.on('error', (err) => {
    log('ERROR: 管理界面服务异常: ' + err.message);
  });
  mgmtServer.listen(SOCKET_PATH, () => {
    // 网关进程通常以别的用户运行，放宽权限确保可访问
    try {
      fs.chmodSync(SOCKET_PATH, 0o666);
    } catch (e) {
      log('WARN: chmod socket 失败: ' + e.message);
    }
    log('管理界面已监听 Unix Socket: ' + SOCKET_PATH + '（网关路径 ' + GATEWAY_PREFIX + '）');
  });

  // 2) API 代理：TCP
  const apiServer = http.createServer(apiHandler);
  apiServer.on('error', (err) => {
    log('ERROR: API 代理服务异常: ' + (err && err.code === 'EADDRINUSE'
      ? '端口 ' + API_PORT + ' 已被占用，请在应用设置中更换端口'
      : err.message));
  });
  apiServer.listen(API_PORT, API_HOST, () => {
    log('API 代理已监听 ' + API_HOST + ':' + API_PORT + '（鉴权: ' + (ADMIN_KEY ? '开启' : '关闭') + '）');
  });

  log('Chat2API fnOS 服务端启动完成 version=' + VERSION + ' node=' + process.version +
      ' core=' + (core ? 'ready' : 'placeholder'));

  const shutdown = () => {
    log('收到退出信号，正在关闭...');
    mgmtServer.close();
    apiServer.close();
    setTimeout(() => cleanupAndExit(0), 300).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (err) => {
    log('uncaughtException: ' + (err && err.stack ? err.stack : err));
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection: ' + reason);
  });
}

bootstrap();

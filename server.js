'use strict';

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const compression = require('compression');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-security-policy', 'x-frame-options', 'strict-transport-security',
]);

/**
 * ターゲットサイトに送るヘッダーを構築（ブラウザに完全になりすます）
 */
function prepareTargetHeaders(req, targetUrl) {
  const parsed = new URL(targetUrl);
  const out = {};

  // クライアントからのヘッダーをコピー（一部除外）
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'host' || lower.includes('render')) continue;
    out[k] = v;
  }

  // ブラウザ偽装用ヘッダーの強制上書き
  out['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  out['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  out['Accept-Language'] = 'ja,en-US;q=0.9,en;q=0.8';
  out['Referer'] = parsed.origin + '/';
  out['Origin'] = parsed.origin;
  
  // セキュリティヘッダー（ボット検知回避）
  out['Sec-Ch-Ua'] = '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"';
  out['Sec-Ch-Ua-Mobile'] = '?0';
  out['Sec-Ch-Ua-Platform'] = '"Windows"';
  out['Sec-Fetch-Dest'] = 'document';
  out['Sec-Fetch-Mode'] = 'navigate';
  out['Sec-Fetch-Site'] = 'same-origin';

  return out;
}

function proxyUrl(targetUrl, req) {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML/CSS Rewriters (既存のロジックを最適化)
// ─────────────────────────────────────────────────────────────────────────────

function rewriteHtml(html, baseUrl, req) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // URL書き換え対象の属性
  const attrMap = {
    'a': ['href'], 'link': ['href'], 'script': ['src'], 'img': ['src', 'data-src'],
    'iframe': ['src'], 'form': ['action'], 'source': ['src', 'srcset'], 'video': ['src']
  };

  for (const [tag, attrs] of Object.entries(attrMap)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const val = $(el).attr(attr);
        if (val && !val.startsWith('data:') && !val.startsWith('#')) {
          try {
            const resolved = new URL(val, baseUrl).href;
            $(el).attr(attr, proxyUrl(resolved, req));
          } catch (e) {}
        }
      }
    });
  }

  // インジェクション：ページ内のリンクを動的にキャッチするJS
  const injectCode = `
    <script>
    (function() {
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string' && input.includes('http') && !input.includes(location.host)) {
          input = '/proxy?url=' + encodeURIComponent(input);
        }
        return originalFetch(input, init);
      };
    })();
    </script>
  `;
  $('head').append(injectCode);

  return $.html();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Proxy Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleProxy(req, res) {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL missing');

  if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: prepareTargetHeaders(req, targetUrl),
      body: ['POST', 'PUT'].includes(req.method) ? req.body : undefined,
      redirect: 'follow'
    });

    // 相手サイトからのCookieをクライアントに転送
    const cookies = response.headers.raw()['set-cookie'];
    if (cookies) res.setHeader('Set-Cookie', cookies);

    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);

    if (contentType.includes('text/html')) {
      const buffer = await response.buffer();
      const html = iconv.decode(buffer, 'utf-8');
      return res.send(rewriteHtml(html, targetUrl, req));
    }

    // 画像やバイナリデータはそのままストリーム
    response.body.pipe(res);

  } catch (err) {
    res.status(500).send('Proxy Error: ' + err.message);
  }
}

app.all('/proxy', handleProxy);
app.get('/', (req, res) => res.send('Proxy is running. Use /proxy?url=https://...'));

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

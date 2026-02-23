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

// 圧縮とパース設定
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 除外すべきホップバイホップヘッダー
 */
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-security-policy', 'x-frame-options', 'strict-transport-security',
]);

/**
 * ターゲットサイトに送るヘッダーをブラウザレベルまで偽装
 */
function prepareTargetHeaders(req, targetUrl) {
  const parsed = new URL(targetUrl);
  const headers = {};

  // クライアントからのヘッダーをコピー
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower === 'host' || lower.includes('render')) continue;
    headers[k] = v;
  }

  // 強力なブラウザ偽装
  headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  headers['Accept-Language'] = 'ja,en-US;q=0.9,en;q=0.8';
  headers['Referer'] = parsed.origin + '/';
  headers['Origin'] = parsed.origin;
  
  // Cloudflare等のボット検知回避用
  headers['Sec-Ch-Ua'] = '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"';
  headers['Sec-Ch-Ua-Mobile'] = '?0';
  headers['Sec-Ch-Ua-Platform'] = '"Windows"';
  headers['Sec-Fetch-Dest'] = 'document';
  headers['Sec-Fetch-Mode'] = 'navigate';
  headers['Sec-Fetch-Site'] = 'same-origin';
  headers['Sec-Fetch-User'] = '?1';
  headers['Upgrade-Insecure-Requests'] = '1';

  return headers;
}

/**
 * プロキシURLの生成
 */
function getProxyUrl(targetUrl, req) {
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * HTML内のURLをすべてプロキシ経由に書き換え
 */
function rewriteHtml(html, baseUrl, req) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const attrMap = {
    'a': ['href'], 'link': ['href'], 'script': ['src'], 'img': ['src', 'data-src', 'data-original'],
    'iframe': ['src'], 'form': ['action'], 'source': ['src', 'srcset'], 'video': ['src', 'poster']
  };

  for (const [tag, attrs] of Object.entries(attrMap)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const val = $(el).attr(attr);
        if (!val || val.startsWith('data:') || val.startsWith('#') || val.startsWith('javascript:')) continue;
        try {
          const resolved = new URL(val, baseUrl).href;
          $(el).attr(attr, getProxyUrl(resolved, req));
        } catch (e) {}
      }
    });
  }

  // ページ内JSの通信（fetch/XHR）も強制的にプロキシへ向けるインジェクション
  const injection = `
    <script>
    (function() {
      const _originFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string' && !input.startsWith('/') && !input.includes(location.host)) {
          input = '/proxy?url=' + encodeURIComponent(new URL(input, document.baseURI).href);
        }
        return _originFetch(input, init);
      };
      // リンクの動的クリックも監視
      document.addEventListener('click', e => {
        const a = e.target.closest('a');
        if (a && a.href && !a.href.includes(location.host) && !a.href.startsWith('javascript:')) {
            e.preventDefault();
            location.href = '/proxy?url=' + encodeURIComponent(a.href);
        }
      }, true);
    })();
    </script>
  `;
  $('head').prepend(injection);

  return $.html();
}

/**
 * メインプロキシハンドラ
 */
async function handleProxy(req, res) {
  let targetUrl = req.query.url || req.body.url;
  if (!targetUrl) return res.status(400).send('Error: target URL is required.');

  if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

  try {
    const fetchOptions = {
      method: req.method,
      headers: prepareTargetHeaders(req, targetUrl),
      redirect: 'follow',
      compress: true
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    // 相手サイトからのCookieをクライアントへ引き継ぐ
    const setCookies = response.headers.raw()['set-cookie'];
    if (setCookies) res.setHeader('Set-Cookie', setCookies);

    // ヘッダーのクリーンアップ転送
    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);
    res.setHeader('Content-Type', contentType);

    // HTML/CSSの書き換え処理
    if (contentType.includes('text/html')) {
      const buffer = await response.buffer();
      const html = iconv.decode(buffer, 'utf-8');
      return res.send(rewriteHtml(html, targetUrl, req));
    }

    // 画像、動画、その他のバイナリはストリーム転送
    response.body.pipe(res);

  } catch (err) {
    console.error('Proxy Fatal Error:', err.message);
    res.status(500).send('Proxy Error: ' + err.message);
  }
}

// ルート設定
app.all('/proxy', handleProxy);
app.get('/', (req, res) => {
    res.send('<h1>Universal Proxy Server</h1><p>Usage: /proxy?url=https://example.com</p>');
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy service running on port ${PORT}`);
});

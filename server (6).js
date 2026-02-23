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

/**
 * Blocked headers we should not forward to target or return to client.
 */
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'content-security-policy', 'x-frame-options', 'x-content-type-options',
  'strict-transport-security', 'access-control-allow-origin',
  'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'x-xss-protection',
]);

function sanitizeRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (lower === 'host') continue;
    out[k] = v;
  }
  out['Accept-Encoding'] = 'gzip, deflate, br';
  return out;
}

function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers.raw ? headers.raw() : {})) {
    const lower = k.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') continue; // We handle cookies separately
    out[k] = v.join(', ');
  }
  // Allow embedding
  out['Access-Control-Allow-Origin'] = '*';
  out['X-Frame-Options'] = 'SAMEORIGIN';
  return out;
}

/**
 * Resolve a possibly-relative URL against a base URL.
 */
function resolveUrl(base, target) {
  try {
    return new URL(target, base).href;
  } catch {
    return null;
  }
}

/**
 * Turn any absolute URL into our proxy path.
 */
function proxyUrl(targetUrl, req) {
  const scheme = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${scheme}://${host}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Rewrite all URLs in a CSS string.
 */
function rewriteCss(css, baseUrl, req) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
    if (url.startsWith('data:')) return match;
    const resolved = resolveUrl(baseUrl, url);
    if (!resolved) return match;
    return `url(${quote}${proxyUrl(resolved, req)}${quote})`;
  });
}

/**
 * Rewrite all URLs in an HTML document using cheerio.
 */
function rewriteHtml(html, baseUrl, req) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const attrMap = {
    'a': ['href'],
    'link': ['href'],
    'script': ['src'],
    'img': ['src', 'data-src', 'data-original'],
    'iframe': ['src'],
    'form': ['action'],
    'source': ['src', 'srcset'],
    'video': ['src', 'poster'],
    'audio': ['src'],
    'track': ['src'],
    'input': ['src'],
    'blockquote': ['cite'],
    'ins': ['cite'],
    'del': ['cite'],
    'q': ['cite'],
    'button': ['formaction'],
  };

  // Rewrite standard attributes
  for (const [tag, attrs] of Object.entries(attrMap)) {
    $(tag).each((_, el) => {
      for (const attr of attrs) {
        const val = $(el).attr(attr);
        if (!val) continue;
        if (val.startsWith('javascript:') || val.startsWith('data:') || val.startsWith('#') || val.startsWith('mailto:')) continue;
        if (attr === 'srcset') {
          const rewritten = val.split(',').map(part => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.lastIndexOf(' ');
            const rawUrl = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
            const descriptor = spaceIdx > 0 ? trimmed.slice(spaceIdx) : '';
            const resolved = resolveUrl(baseUrl, rawUrl);
            return resolved ? proxyUrl(resolved, req) + descriptor : part;
          }).join(', ');
          $(el).attr(attr, rewritten);
        } else {
          const resolved = resolveUrl(baseUrl, val);
          if (resolved) $(el).attr(attr, proxyUrl(resolved, req));
        }
      }
    });
  }

  // Rewrite <meta> refresh
  $('meta[http-equiv="refresh"]').each((_, el) => {
    const content = $(el).attr('content');
    if (!content) return;
    const match = content.match(/^(\d+;\s*url=)(.+)$/i);
    if (match) {
      const resolved = resolveUrl(baseUrl, match[2]);
      if (resolved) $(el).attr('content', match[1] + proxyUrl(resolved, req));
    }
  });

  // Remove <base> tag (we handle base ourselves)
  $('base').remove();

  // Inject base-fix + JS URL interceptor
  const injectedScript = `
<script>
(function(){
  var __proxyBase = ${JSON.stringify(baseUrl)};
  var __proxyRoot = ${JSON.stringify((() => {
    // Will be replaced at runtime — just a placeholder here
    return '';
  })())};

  // Override fetch
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && !input.startsWith('/proxy') && !input.startsWith('data:') && !input.startsWith('blob:')) {
      try {
        var resolved = new URL(input, __proxyBase).href;
        input = '/proxy?url=' + encodeURIComponent(resolved);
      } catch(e) {}
    }
    return _origFetch.apply(this, [input, init]);
  };

  // Override XMLHttpRequest
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && !url.startsWith('/proxy') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      try {
        var resolved = new URL(url, __proxyBase).href;
        arguments[1] = '/proxy?url=' + encodeURIComponent(resolved);
      } catch(e) {}
    }
    return _origOpen.apply(this, arguments);
  };

  // Intercept link clicks and form submissions
  document.addEventListener('click', function(e) {
    var el = e.target.closest('a[href]');
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) return;
    try {
      var resolved = new URL(href, __proxyBase).href;
      if (!el.href.includes('/proxy?url=')) {
        e.preventDefault();
        window.location.href = '/proxy?url=' + encodeURIComponent(resolved);
      }
    } catch(e) {}
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var action = form.getAttribute('action') || __proxyBase;
    try {
      var resolved = new URL(action, __proxyBase).href;
      if (!form.action.includes('/proxy?url=')) {
        e.preventDefault();
        var formData = new FormData(form);
        var method = (form.method || 'GET').toUpperCase();
        if (method === 'GET') {
          var params = new URLSearchParams(formData).toString();
          window.location.href = '/proxy?url=' + encodeURIComponent(resolved + (resolved.includes('?') ? '&' : '?') + params);
        } else {
          var proxyForm = document.createElement('form');
          proxyForm.method = 'POST';
          proxyForm.action = '/proxy?url=' + encodeURIComponent(resolved);
          proxyForm.style.display = 'none';
          for (var pair of formData.entries()) {
            var inp = document.createElement('input');
            inp.name = pair[0];
            inp.value = pair[1];
            proxyForm.appendChild(inp);
          }
          document.body.appendChild(proxyForm);
          proxyForm.submit();
        }
      }
    } catch(e2) {}
  }, true);
})();
</script>`;

  // Inject before closing </body> or at end
  if ($('body').length) {
    $('body').append(injectedScript);
  } else {
    $.root().append(injectedScript);
  }

  // Rewrite inline styles
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (style && style.includes('url(')) {
      $(el).attr('style', rewriteCss(style, baseUrl, req));
    }
  });

  // Rewrite <style> tags
  $('style').each((_, el) => {
    const css = $(el).html();
    if (css) $(el).html(rewriteCss(css, baseUrl, req));
  });

  return $.html();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Proxy Handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleProxy(req, res) {
  let targetUrl = req.query.url || req.body?.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Auto-add https if missing
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Block localhost/internal
  const hostname = parsedTarget.hostname;
  if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/.test(hostname)) {
    return res.status(403).json({ error: 'Private/internal URLs are not allowed' });
  }

  try {
    // Build fetch options
    const method = req.method;
    const fetchOptions = {
      method,
      headers: sanitizeRequestHeaders(req.headers),
      redirect: 'follow',
      follow: 10,
      timeout: 30000,
      compress: true,
    };

    // Forward body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(method) && req.body) {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        fetchOptions.body = JSON.stringify(req.body);
        fetchOptions.headers['Content-Type'] = 'application/json';
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        fetchOptions.body = new URLSearchParams(req.body).toString();
        fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        fetchOptions.body = req.body;
      }
    }

    const response = await fetch(targetUrl, fetchOptions);

    const contentType = response.headers.get('content-type') || '';
    const status = response.status;

    // Forward sanitized response headers
    const safeHeaders = sanitizeResponseHeaders(response.headers);
    for (const [k, v] of Object.entries(safeHeaders)) {
      try { res.setHeader(k, v); } catch {}
    }

    res.status(status);

    // ── HTML: rewrite URLs ──
    if (contentType.includes('text/html')) {
      const buffer = await response.buffer();

      // Detect charset
      let charset = 'utf-8';
      const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
      if (charsetMatch) charset = charsetMatch[1];

      let html;
      try {
        html = iconv.decode(buffer, charset);
      } catch {
        html = buffer.toString('utf-8');
      }

      const rewritten = rewriteHtml(html, response.url || targetUrl, req);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(rewritten, 'utf-8'));
      return res.send(rewritten);
    }

    // ── CSS: rewrite URLs ──
    if (contentType.includes('text/css')) {
      const text = await response.text();
      const rewritten = rewriteCss(text, response.url || targetUrl, req);
      res.setHeader('Content-Type', contentType);
      return res.send(rewritten);
    }

    // ── JavaScript: basic URL substitution ──
    if (contentType.includes('javascript') || contentType.includes('application/x-javascript')) {
      const text = await response.text();
      // Rewrite absolute http(s):// URLs embedded in JS strings
      const rewritten = text.replace(/"(https?:\/\/[^"\\]+)"/g, (m, url) => {
        try {
          new URL(url); // validate
          return `"/proxy?url=${encodeURIComponent(url)}"`;
        } catch { return m; }
      }).replace(/'(https?:\/\/[^'\\]+)'/g, (m, url) => {
        try {
          new URL(url);
          return `'/proxy?url=${encodeURIComponent(url)}'`;
        } catch { return m; }
      });
      res.setHeader('Content-Type', contentType);
      return res.send(rewritten);
    }

    // ── Everything else: stream directly ──
    response.body.pipe(res);

  } catch (err) {
    console.error('[Proxy Error]', err.message);

    if (res.headersSent) return;

    if (err.type === 'request-timeout' || err.code === 'ETIMEDOUT') {
      return res.status(504).json({ error: 'Gateway timeout', message: 'Target server took too long to respond.' });
    }
    if (err.code === 'ENOTFOUND') {
      return res.status(502).json({ error: 'DNS error', message: `Cannot resolve host: ${err.hostname}` });
    }
    if (err.code === 'ECONNREFUSED') {
      return res.status(502).json({ error: 'Connection refused', message: 'Target server refused the connection.' });
    }

    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// API: check if URL is reachable before proxying
app.get('/api/check', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ ok: false });
  try {
    const r = await fetch(url, { method: 'HEAD', timeout: 8000, redirect: 'follow' });
    res.json({ ok: true, status: r.status, contentType: r.headers.get('content-type') });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Proxy endpoint — handles all methods
app.all('/proxy', handleProxy);

// Fallback: serve index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});

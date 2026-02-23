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

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function prepareTargetHeaders(req, targetUrl) {
    const parsed = new URL(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        'Cookie': req.headers['cookie'] || ''
    };
}

function rewriteHtml(html, baseUrl, req) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyUrlBase = `${protocol}://${host}/proxy?url=`;

    // 静的なタグの書き換え
    const attrMap = { 'a': 'href', 'link': 'href', 'script': 'src', 'img': 'src', 'form': 'action', 'iframe': 'src' };
    Object.entries(attrMap).forEach(([tag, attr]) => {
        $(tag).each((_, el) => {
            const val = $(el).attr(attr);
            if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
                try {
                    const resolved = new URL(val, baseUrl).href;
                    $(el).attr(attr, proxyUrlBase + encodeURIComponent(resolved));
                } catch (e) {}
            }
        });
    });

    // --- ブラウザのURL操作を完全にプロキシへ縛り付けるインジェクション ---
    const trackerScript = `
    <script>
    (function() {
        const PROXY_SERVER = "${proxyUrlBase}";
        const TARGET_ORIGIN = "${new URL(baseUrl).origin}";

        function toProxyUrl(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith(PROXY_SERVER) || url.startsWith('data:') || url.startsWith('#')) return url;
            try {
                const resolved = new URL(url, window.location.href.includes('url=') ? decodeURIComponent(window.location.href.split('url=')[1]) : TARGET_ORIGIN).href;
                return PROXY_SERVER + encodeURIComponent(resolved);
            } catch(e) { return url; }
        }

        // 1. History API (pushState/replaceState) のフック - これがYouTube対策の肝
        const _pushState = history.pushState;
        const _replaceState = history.replaceState;

        history.pushState = function(state, title, url) {
            return _pushState.apply(this, [state, title, toProxyUrl(url)]);
        };
        history.replaceState = function(state, title, url) {
            return _replaceState.apply(this, [state, title, toProxyUrl(url)]);
        };

        // 2. リンククリックの強制書き換え
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (a && a.href) {
                const rawHref = a.getAttribute('href');
                if (rawHref && !rawHref.startsWith(PROXY_SERVER) && !rawHref.startsWith('#')) {
                    e.preventDefault();
                    window.location.href = toProxyUrl(rawHref);
                }
            }
        }, true);

        // 3. フォーム送信 (検索ボックス等)
        document.addEventListener('submit', e => {
            const form = e.target;
            const action = form.getAttribute('action');
            if (action && !action.startsWith(PROXY_SERVER)) {
                e.preventDefault();
                const targetUrl = new URL(action, TARGET_ORIGIN).href;
                const formData = new FormData(form);
                const params = new URLSearchParams(formData).toString();
                window.location.href = PROXY_SERVER + encodeURIComponent(targetUrl + (targetUrl.includes('?') ? '&' : '?') + params);
            }
        }, true);

        // 4. Fetch / XHR のフック
        const _origFetch = window.fetch;
        window.fetch = function(u, i) {
            if (typeof u === 'string' && !u.startsWith(PROXY_SERVER)) u = toProxyUrl(u);
            return _origFetch(u, i);
        };
    })();
    </script>
    `;
    $('head').prepend(trackerScript);

    return $.html();
}

app.all('/proxy', async (req, res) => {
    let targetUrl = req.query.url || req.body.url;
    if (!targetUrl) return res.status(400).send('URL missing');
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: prepareTargetHeaders(req, targetUrl),
            body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined,
            compress: true
        });

        const contentType = response.headers.get('content-type') || '';
        res.status(response.status);

        if (contentType.includes('text/html')) {
            const buffer = await response.buffer();
            let charset = 'utf-8';
            const charsetMatch = contentType.match(/charset=([^;]+)/i);
            if (charsetMatch) charset = charsetMatch[1].trim();
            const decoded = iconv.decode(buffer, charset);
            return res.send(rewriteHtml(decoded, targetUrl, req));
        }

        // 画像などはそのまま
        res.setHeader('Content-Type', contentType);
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send('Proxy Error: ' + err.message);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Locked Proxy running on port ${PORT}`));

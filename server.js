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

/**
 * ターゲットヘッダーの準備
 */
function prepareTargetHeaders(req, targetUrl) {
    const parsed = new URL(targetUrl);
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        'Cookie': req.headers['cookie'] || ''
    };
}

/**
 * HTML書き換えと追跡スクリプトの注入
 */
function rewriteHtml(html, baseUrl, req) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyUrlBase = `${protocol}://${host}/proxy?url=`;

    // 1. 静的なタグのURLをすべてプロキシ経由に
    const attrMap = {
        'a': 'href', 'link': 'href', 'script': 'src', 'img': 'src', 
        'form': 'action', 'iframe': 'src', 'source': 'src', 'video': 'src'
    };

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

    // 2. サイト内での挙動をすべてプロキシに固定するJSの注入
    const trackerScript = `
    <script>
    (function() {
        const PROXY_SERVER = "${proxyUrlBase}";
        const BASE_URL = "${baseUrl}";

        function toProxyUrl(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('data:') || url.startsWith('#') || url.startsWith('javascript:')) return url;
            try {
                const resolved = new URL(url, BASE_URL).href;
                if (resolved.includes(location.host)) return url; // すでにプロキシ済みの場合はそのまま
                return PROXY_SERVER + encodeURIComponent(resolved);
            } catch(e) { return url; }
        }

        // aタグのクリックを全監視
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith(PROXY_SERVER) && !a.href.startsWith('#')) {
                e.preventDefault();
                window.location.href = toProxyUrl(a.getAttribute('href'));
            }
        }, true);

        // フォームの送信を全監視
        document.addEventListener('submit', e => {
            const form = e.target;
            if (form.action && !form.action.startsWith(PROXY_SERVER)) {
                form.action = toProxyUrl(form.getAttribute('action'));
            }
        }, true);

        // Fetch / XHR のフック
        const _origFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string') input = toProxyUrl(input);
            return _origFetch(input, init);
        };

        const _origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, url) {
            return _origOpen.apply(this, [m, toProxyUrl(url), ...Array.from(arguments).slice(2)]);
        };
    })();
    </script>
    `;
    $('head').prepend(trackerScript);

    return $.html();
}

/**
 * プロキシハンドラ
 */
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
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) res.setHeader('Set-Cookie', setCookies);

        // HTMLの場合
        if (contentType.includes('text/html')) {
            const buffer = await response.buffer();
            let charset = 'utf-8';
            const charsetMatch = contentType.match(/charset=([^;]+)/i);
            if (charsetMatch) charset = charsetMatch[1].trim();

            const decoded = iconv.decode(buffer, charset);
            const rewritten = rewriteHtml(decoded, targetUrl, req);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(response.status).send(rewritten);
        }

        // CSS内のURL書き換え（簡易）
        if (contentType.includes('text/css')) {
            let css = await response.text();
            const host = req.get('host');
            const proxyBase = `${req.protocol}://${host}/proxy?url=`;
            css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                try {
                    const resolved = new URL(url, targetUrl).href;
                    return `url("${proxyBase}${encodeURIComponent(resolved)}")`;
                } catch(e) { return match; }
            });
            res.setHeader('Content-Type', 'text/css');
            return res.send(css);
        }

        // バイナリストリーム（画像など）
        res.setHeader('Content-Type', contentType);
        res.status(response.status);
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send('Proxy Error: ' + err.message);
    }
});

// ルートアクセス
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Trackable Proxy running on port ${PORT}`));

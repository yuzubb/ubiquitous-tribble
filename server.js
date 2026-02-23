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
 * ターゲットヘッダーの準備（YouTube等のボット対策回避）
 */
function prepareTargetHeaders(req, targetUrl) {
    const parsed = new URL(targetUrl);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        // ホスト名やプロキシ固有のヘッダーは転送しない
        if (['host', 'connection', 'referer', 'origin'].includes(lower) || lower.includes('render') || lower.includes('vercel')) continue;
        headers[k] = v;
    }
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    headers['Referer'] = parsed.origin + '/';
    headers['Origin'] = parsed.origin;
    return headers;
}

/**
 * HTML書き換え：ブラウザの挙動を完全にプロキシ内に閉じ込める
 */
function rewriteHtml(html, baseUrl, req) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyBase = `${protocol}://${host}/proxy?url=`;
    const targetOrigin = new URL(baseUrl).origin;

    // 1. 静的要素のURLをプロキシ経由に置換
    const attrMap = { 'a': 'href', 'link': 'href', 'script': 'src', 'img': 'src', 'form': 'action', 'iframe': 'src' };
    Object.entries(attrMap).forEach(([tag, attr]) => {
        $(tag).each((_, el) => {
            const val = $(el).attr(attr);
            if (val && !val.startsWith('data:') && !val.startsWith('#')) {
                try {
                    const resolved = new URL(val, baseUrl).href;
                    $(el).attr(attr, proxyBase + encodeURIComponent(resolved));
                } catch (e) {}
            }
        });
    });

    // 2. JavaScriptサンドボックスの注入
    // ブラウザのURL操作関数(pushState等)をすべて横取りして /proxy?url= を強制付与する
    const injection = `
    <script>
    (function() {
        const PROXY_SERVER = "${proxyBase}";
        const ORIGINAL_ORIGIN = "${targetOrigin}";

        function forceProxy(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith(PROXY_SERVER) || url.startsWith('data:') || url.startsWith('#')) return url;
            try {
                // 相対パスをターゲットドメインの絶対パスに変換してからプロキシURLを作成
                const absolute = new URL(url, ORIGINAL_ORIGIN).href;
                return PROXY_SERVER + encodeURIComponent(absolute);
            } catch(e) { return url; }
        }

        // Location書き換えの監視（pushState / replaceState）
        const _ps = history.pushState;
        const _rs = history.replaceState;
        history.pushState = function(state, title, url) {
            return _ps.apply(this, [state, title, forceProxy(url)]);
        };
        history.replaceState = function(state, title, url) {
            return _rs.apply(this, [state, title, forceProxy(url)]);
        };

        // 全リンククリックのフック
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (a && a.href) {
                const href = a.getAttribute('href');
                if (href && !href.startsWith(PROXY_SERVER) && !href.startsWith('#')) {
                    e.preventDefault();
                    window.location.href = forceProxy(href);
                }
            }
        }, true);

        // 全フォーム送信のフック
        document.addEventListener('submit', e => {
            const form = e.target;
            const action = form.getAttribute('action');
            if (action && !action.startsWith(PROXY_SERVER)) {
                e.preventDefault();
                const targetAction = new URL(action, ORIGINAL_ORIGIN).href;
                const fd = new URLSearchParams(new FormData(form)).toString();
                window.location.href = PROXY_SERVER + encodeURIComponent(targetAction + (targetAction.includes('?') ? '&' : '?') + fd);
            }
        }, true);

        // 通信(Fetch/XHR)のフック
        const _fetch = window.fetch;
        window.fetch = function(u, i) {
            if (typeof u === 'string') u = forceProxy(u);
            return _fetch(u, i);
        };
        const _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u) {
            return _open.apply(this, [m, forceProxy(u), ...Array.from(arguments).slice(2)]);
        };
    })();
    </script>
    `;
    $('head').prepend(injection);

    return $.html();
}

/**
 * プロキシメインロジック
 */
app.all('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Target URL required');
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: prepareTargetHeaders(req, targetUrl),
            redirect: 'follow',
            compress: true
        });

        const contentType = response.headers.get('content-type') || '';
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) res.setHeader('Set-Cookie', setCookies);

        res.status(response.status);

        if (contentType.includes('text/html')) {
            const buffer = await response.buffer();
            let charset = 'utf-8';
            const cm = contentType.match(/charset=([^;]+)/i);
            if (cm) charset = cm[1].trim();
            const decoded = iconv.decode(buffer, charset);
            return res.send(rewriteHtml(decoded, targetUrl, req));
        }

        res.setHeader('Content-Type', contentType);
        response.body.pipe(res);

    } catch (err) {
        res.status(502).send('Proxy Error: ' + err.message);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Locked-Domain Proxy running on port ${PORT}`));

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
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (['host', 'connection', 'referer', 'origin'].includes(lower) || lower.includes('vercel') || lower.includes('render')) continue;
        headers[k] = v;
    }
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    headers['Referer'] = parsed.origin + '/';
    headers['Origin'] = parsed.origin;
    return headers;
}

function rewriteHtml(html, baseUrl, req) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyBase = `${protocol}://${host}/proxy?url=`;
    const targetUrlObj = new URL(baseUrl);

    // 全てのURLを絶対パスに変換してからプロキシを通す
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

    // 究極のURLロック・偽装スクリプト
    const injection = `
    <script>
    (function() {
        const PROXY_SERVER = "${proxyBase}";
        const TARGET_ORIGIN = "${targetUrlObj.origin}";
        const TARGET_DOMAIN = "${targetUrlObj.hostname}";

        function toProxy(u) {
            if (!u || typeof u !== 'string' || u.startsWith(PROXY_SERVER) || u.startsWith('data:')) return u;
            try { return PROXY_SERVER + encodeURIComponent(new URL(u, window.location.href.split('url=')[1] || TARGET_ORIGIN).href); }
            catch(e) { return u; }
        }

        // 1. YouTube側のリダイレクトを阻止するために Location プロパティを保護
        // ※完全な上書きはブラウザ制限があるため、Historyとイベントで徹底対抗
        const _ps = history.pushState;
        const _rs = history.replaceState;
        history.pushState = function(s, t, u) { return _ps.apply(this, [s, t, toProxy(u)]); };
        history.replaceState = function(s, t, u) { return _rs.apply(this, [s, t, toProxy(u)]); };

        // 2. 自動リダイレクト（location.assign等）を無効化する試み
        window.onbeforeunload = function() { return; }; 

        // 3. クリック・フォームの強制プロキシ化
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith(PROXY_SERVER)) {
                e.preventDefault();
                window.location.href = toProxy(a.getAttribute('href'));
            }
        }, true);

        document.addEventListener('submit', e => {
            const f = e.target;
            if (f.action && !f.action.startsWith(PROXY_SERVER)) {
                e.preventDefault();
                const target = new URL(f.getAttribute('action'), TARGET_ORIGIN).href;
                const qs = new URLSearchParams(new FormData(f)).toString();
                window.location.href = PROXY_SERVER + encodeURIComponent(target + "?" + qs);
            }
        }, true);

        // 4. 通信の全フック
        const _fetch = window.fetch;
        window.fetch = function(u, i) { return _fetch(toProxy(u), i); };
        const _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u) { 
            return _open.apply(this, [m, toProxy(u), ...Array.from(arguments).slice(2)]);
        };
    })();
    </script>
    `;
    $('head').prepend(injection);
    return $.html();
}

app.all('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL missing');
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: prepareTargetHeaders(req, targetUrl),
            redirect: 'manual' // 勝手なリダイレクトをサーバー側で止める
        });

        // リダイレクト（301/302）が発生した場合、プロキシURLに変換してクライアントに送る
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            const resolved = new URL(location, targetUrl).href;
            return res.redirect(`/proxy?url=${encodeURIComponent(resolved)}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const buffer = await response.buffer();

        if (contentType.includes('text/html')) {
            const html = iconv.decode(buffer, 'utf-8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(rewriteHtml(html, targetUrl, req));
        }

        res.setHeader('Content-Type', contentType);
        res.send(buffer);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT);

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

// 1. 圧縮とパース設定
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. 静的ファイルの提供設定 (publicフォルダ内のファイルを配信)
app.use(express.static(path.join(__dirname, 'public')));

/**
 * ターゲットサイトに送るヘッダーを偽装
 */
function prepareTargetHeaders(req, targetUrl) {
    const parsed = new URL(targetUrl);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        'Cookie': req.headers['cookie'] || ''
    };
    return headers;
}

/**
 * 文字化け対策を施したHTML書き換え
 */
function rewriteHtml(html, baseUrl, req) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyBase = `${protocol}://${host}/proxy?url=`;

    const attrMap = {
        'a': ['href'], 'link': ['href'], 'script': ['src'], 'img': ['src', 'data-src'],
        'iframe': ['src'], 'form': ['action'], 'source': ['src'], 'video': ['src']
    };

    for (const [tag, attrs] of Object.entries(attrMap)) {
        $(tag).each((_, el) => {
            for (const attr of attrs) {
                const val = $(el).attr(attr);
                if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
                    try {
                        const resolved = new URL(val, baseUrl).href;
                        $(el).attr(attr, proxyBase + encodeURIComponent(resolved));
                    } catch (e) {}
                }
            }
        });
    }

    // JSインジェクション（相対パスの動的解決用）
    $('head').prepend(`
        <script>
        (function() {
            const _origFetch = window.fetch;
            window.fetch = function(u, i) {
                if (typeof u === 'string' && u.includes('http') && !u.includes(location.host)) {
                    u = '/proxy?url=' + encodeURIComponent(u);
                }
                return _origFetch(u, i);
            };
        })();
        </script>
    `);

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
            body: ['POST', 'PUT'].includes(req.method) ? JSON.stringify(req.body) : undefined,
            compress: true
        });

        const contentType = response.headers.get('content-type') || '';
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) res.setHeader('Set-Cookie', setCookies);

        // --- HTMLの場合の文字化け対策 ---
        if (contentType.includes('text/html')) {
            const buffer = await response.buffer();
            
            // charset判定
            let charset = 'utf-8';
            const charsetMatch = contentType.match(/charset=([^;]+)/i);
            if (charsetMatch) charset = charsetMatch[1].trim();

            // 正しいエンコードでデコードしてから加工
            const decoded = iconv.decode(buffer, charset);
            const rewritten = rewriteHtml(decoded, targetUrl, req);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(response.status).send(rewritten);
        }

        // --- それ以外（画像やJS）はバイナリとしてそのまま流す ---
        res.setHeader('Content-Type', contentType);
        res.status(response.status);
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send('Proxy Error: ' + err.message);
    }
});

// 3. ルートURLの時に public/index.html を表示する設定
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`🚀 Proxy running on port ${PORT}`);
});

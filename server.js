'use strict';

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const compression = require('compression');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ヘッダー偽装用
function getTargetHeaders(req, targetUrl) {
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

function rewriteUrls(html, baseUrl, host) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const attrMap = { 'a': 'href', 'link': 'href', 'script': 'src', 'img': 'src', 'form': 'action' };

    Object.entries(attrMap).forEach(([tag, attr]) => {
        $(tag).each((_, el) => {
            const val = $(el).attr(attr);
            if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
                try {
                    const resolved = new URL(val, baseUrl).href;
                    $(el).attr(attr, `/proxy?url=${encodeURIComponent(resolved)}`);
                } catch (e) {}
            }
        });
    });
    return $.html();
}

app.all('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URLが必要です');
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: getTargetHeaders(req, targetUrl),
            body: ['POST', 'PUT'].includes(req.method) ? JSON.stringify(req.body) : undefined,
            compress: true // 自動解凍を有効にする
        });

        const contentType = response.headers.get('content-type') || '';
        
        // クッキーの中継
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) res.setHeader('Set-Cookie', setCookies);

        // HTMLの場合：文字コードを考慮してデコード
        if (contentType.includes('text/html')) {
            const buffer = await response.buffer();
            
            // charsetの判定（ヘッダーから取得、なければutf-8）
            let charset = 'utf-8';
            const charsetMatch = contentType.match(/charset=([^;]+)/i);
            if (charsetMatch) charset = charsetMatch[1].trim();

            // デコード -> 書き換え -> 再エンコードして送信
            const decodedHtml = iconv.decode(buffer, charset);
            const rewrittenHtml = rewriteUrls(decodedHtml, targetUrl, req.get('host'));
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(response.status).send(rewrittenHtml);
        }

        // HTML以外（画像、JS、CSSなど）はバイナリとしてそのまま流す
        res.setHeader('Content-Type', contentType);
        res.status(response.status);
        response.body.pipe(res);

    } catch (err) {
        res.status(500).send('通信エラー: ' + err.message);
    }
});

app.get('/', (req, res) => res.send('Proxy Active'));
app.listen(PORT, () => console.log(`Server: ${PORT}`));

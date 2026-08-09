const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const FRAME_TYPES = { web: 'browser', blog: 'browser', android: 'phone', content: 'tablet' };

// Whitelist ekstensi gambar yang aman. WAJIB — `ext` diambil dari nama file yang
// diunggah user (path.extname atas originalname, sepenuhnya bisa diatur bebas oleh
// pengirim request) lalu disuntikkan mentah ke dalam atribut src="data:image/{ext};..."
// di HTML template. Tanpa whitelist ini, nama file seperti
// `evil.png"><img src=x onerror="...">` akan membuat `ext` berisi HTML/JS utuh yang
// lolos ke dalam halaman yang di-screenshot Puppeteer (HTML injection -> XSS di
// dalam context render, berpotensi disalahgunakan untuk SSRF lewat fetch()).
const SAFE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function toDataUri(buffer, ext) {
    const safeExt = SAFE_IMAGE_EXTENSIONS.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'png';
    return `data:image/${safeExt};base64,${buffer.toString('base64')}`;
}

function readTemplate(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'templates', `${name}.html`), 'utf8');
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Placeholder diganti pakai split/join (bukan regex) karena {{...}} berisi karakter
// khusus regex; dan bisa muncul lebih dari sekali per template (mis. BG_COLOR dipakai
// untuk body + cincin bezel), beda dari placeholder lain yang cuma sekali pakai.
function replaceAll(html, placeholder, value) {
    return html.split(placeholder).join(value);
}

// Hanya terima format hex 6 digit yang valid, sisanya jatuh ke warna default.
// Wajib divalidasi karena nilai ini disuntikkan mentah-mentah ke dalam <style> inline;
// tanpa validasi, input sembarangan bisa lolos jadi CSS/HTML injection.
function sanitizeHexColor(input, fallback) {
    if (typeof input === 'string' && /^#[0-9a-fA-F]{6}$/.test(input)) {
        return input;
    }
    return fallback;
}

// Hanya izinkan http/https. WAJIB — tanpa ini, `url` (input bebas dari user) bisa diisi
// file:///C:/Windows/win.ini dan Puppeteer akan menampilkan isi file lokal server ke dalam
// hasil render (local file disclosure), atau skema lain seperti chrome:// yang membuka
// halaman internal browser. Ini bukan proteksi SSRF penuh (http/https ke alamat internal
// seperti 169.254.169.254 atau localhost tetap lolos), jadi tetap hati-hati kalau tool ini
// pernah di-deploy publik dan bisa diakses siapa pun.
function assertSafeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('URL tidak valid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('URL harus dimulai dengan http:// atau https://');
    }
    return parsed;
}

// Pilih warna teks (terang/gelap) otomatis berdasarkan luminansi background,
// supaya teks yang duduk langsung di atas kanvas (mis. nama aplikasi di tipe Android)
// tetap terbaca apa pun warna latar yang dipilih user.
function pickForegroundColor(hexBg) {
    const hex = hexBg.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.substring(i, i + 2), 16) / 255);
    const [rl, gl, bl] = [r, g, b].map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    const luminance = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
    return luminance > 0.5 ? '#111827' : '#e5e7eb';
}

async function generateMockup({ type, url, appName, accountName, username, images = [], bgColor, dualView }) {
    if (!FRAME_TYPES[type]) {
        throw new Error(`Tipe tidak dikenal: ${type}`);
    }

    const frameKind = FRAME_TYPES[type];
    // --disable-lcd-text + --font-render-hinting=none: tanpa ini, teks tebal (mis. username
    // di tipe content) muncul dengan fringing warna pelangi saat di-screenshot headless di Windows.
    const browser = await puppeteer.launch({ args: ['--disable-lcd-text', '--font-render-hinting=none'] });

    try {
        let html;

        if (frameKind === 'browser') {
            if (url) {
                const parsedUrl = assertSafeUrl(url);

                const page = await browser.newPage();
                await page.setViewport({ width: 1400, height: 900 });
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                const base64 = await page.screenshot({ type: 'png', encoding: 'base64' });
                await page.close();

                if (dualView) {
                    // Ambil screenshot kedua di viewport mobile dari URL yang sama, supaya
                    // CSS responsif situsnya benar-benar kepakai (bukan cuma desktop di-crop).
                    const mobilePage = await browser.newPage();
                    await mobilePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
                    await mobilePage.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                    const mobileBase64 = await mobilePage.screenshot({ type: 'png', encoding: 'base64' });
                    await mobilePage.close();

                    html = readTemplate('browser-mobile-duo');
                    html = html.replace('{{SCREENSHOT}}', `data:image/png;base64,${base64}`);
                    html = html.replace('{{SCREENSHOT_MOBILE}}', `data:image/png;base64,${mobileBase64}`);
                    html = html.replace('{{URL_LABEL}}', parsedUrl.hostname);
                } else {
                    html = readTemplate('browser-frame');
                    html = html.replace('{{SCREENSHOT}}', `data:image/png;base64,${base64}`);
                    html = html.replace('{{URL_LABEL}}', parsedUrl.hostname);
                }
            } else if (type === 'web' && images.length > 0) {
                // Aplikasi yang belum dideploy: tidak ada URL untuk di-screenshot,
                // jadi screenshot diunggah manual dan address bar menampilkan nama aplikasi.
                html = readTemplate('browser-frame');
                html = html.replace('{{SCREENSHOT}}', toDataUri(images[0].buffer, images[0].ext));
                html = html.replace('{{URL_LABEL}}', escapeHtml(appName || 'aplikasi'));
            } else {
                throw new Error(type === 'web' ? 'Tipe "web" butuh URL atau screenshot' : `Tipe "${type}" butuh URL`);
            }
        } else if (frameKind === 'phone') {
            if (images.length === 0) {
                throw new Error('Tipe "android" butuh gambar');
            }
            if (!appName) {
                throw new Error('Tipe "android" butuh nama aplikasi');
            }
            const useDuo = images.length >= 2;
            html = readTemplate(useDuo ? 'phone-frame-duo' : 'phone-frame');
            html = html.replace('{{SCREENSHOT}}', toDataUri(images[0].buffer, images[0].ext));
            if (useDuo) {
                html = html.replace('{{SCREENSHOT2}}', toDataUri(images[1].buffer, images[1].ext));
            }
            html = html.replace('{{APP_NAME}}', escapeHtml(appName));
        } else if (frameKind === 'tablet') {
            if (!accountName || !username) {
                throw new Error('Tipe "content" butuh nama akun dan username');
            }
            html = readTemplate('tablet-collage');
            html = html.replace('{{ACCOUNT_NAME}}', escapeHtml(accountName));
            html = html.replace('{{USERNAME}}', escapeHtml(username));
        }

        const bg = sanitizeHexColor(bgColor, '#04060a');
        const fg = pickForegroundColor(bg);
        html = replaceAll(html, '{{BG_COLOR}}', bg);
        html = replaceAll(html, '{{FG_COLOR}}', fg);

        const composePage = await browser.newPage();
        await composePage.setViewport({ width: 1600, height: 900 });
        await composePage.setContent(html, { waitUntil: 'load' });
        await composePage.waitForFunction(() => {
            const imgs = Array.from(document.querySelectorAll('img'));
            return imgs.every(img => img.complete && img.naturalWidth > 0);
        }, { timeout: 15000 });
        const outputBuffer = await composePage.screenshot({ type: 'png' });
        await composePage.close();

        return outputBuffer;
    } finally {
        await browser.close();
    }
}

module.exports = { generateMockup, FRAME_TYPES };

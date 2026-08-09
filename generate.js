const path = require('path');
const fs = require('fs');
const { generateMockup, FRAME_TYPES } = require('./lib/mockup');

function parseArgs() {
    const args = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const next = argv[i + 1];
            const val = next && !next.startsWith('--') ? next : true;
            args[key] = val;
            if (val !== true) i++;
        }
    }
    return args;
}

function loadImage(imgPath) {
    return {
        buffer: fs.readFileSync(imgPath),
        ext: (path.extname(imgPath).slice(1) || 'png').toLowerCase()
    };
}

async function main() {
    const { type, url, appName, accountName, username, bgColor, dualView, image, image2, image3, out } = parseArgs();

    if (!type || !FRAME_TYPES[type]) {
        console.error('Gunakan --type web|blog|android|content');
        process.exit(1);
    }
    if (!out) {
        console.error('Wajib isi --out <nama-file.png>');
        process.exit(1);
    }

    const images = [image, image2, image3].filter(Boolean).map(loadImage);

    if (url) console.log(`Mengambil screenshot dari ${url} ...`);
    console.log('Menyusun mockup...');

    const buffer = await generateMockup({ type, url, appName, accountName, username, bgColor, dualView: Boolean(dualView), images });

    const outDir = path.join(__dirname, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, out);
    fs.writeFileSync(outPath, buffer);

    console.log(`Selesai: ${outPath}`);
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});

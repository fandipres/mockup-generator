const express = require('express');
const multer = require('multer');
const path = require('path');
const { generateMockup } = require('./lib/mockup');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

const uploadFields = upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'image2', maxCount: 1 },
    { name: 'image3', maxCount: 1 },
]);

function fileToImage(file) {
    return {
        buffer: file.buffer,
        ext: (path.extname(file.originalname).slice(1) || 'png').toLowerCase()
    };
}

app.post('/generate', uploadFields, async (req, res) => {
    try {
        const { type, url, appName, accountName, username, bgColor, dualView } = req.body;
        const files = req.files || {};
        const images = ['image', 'image2', 'image3']
            .map(field => files[field] && files[field][0])
            .filter(Boolean)
            .map(fileToImage);

        const buffer = await generateMockup({
            type, url, appName, accountName, username, bgColor, images,
            dualView: dualView === 'true',
        });

        // Tidak ditulis ke disk — dikirim langsung, disimpan hanya kalau user klik unduh.
        res.set('Content-Type', 'image/png');
        res.send(Buffer.from(buffer));
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

const PORT = 3400;
app.listen(PORT, () => {
    console.log(`Buka http://localhost:${PORT} di browser`);
});

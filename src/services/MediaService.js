const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");

const IMAGE_DIR = path.join(__dirname, "..", "..", "uploads", "chat", "images");
const VIDEO_DIR = path.join(__dirname, "..", "..", "uploads", "chat", "videos");
const PDF_DIR = path.join(__dirname, "..", "..", "uploads", "chat", "pdf");
const EXCEL_DIR = path.join(__dirname, "..", "..", "uploads", "chat", "excel");

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function saveDocument(file, type) {
    const dir = type === "pdf" ? PDF_DIR : EXCEL_DIR;
    ensureDir(dir);

    const ext = path.extname(file.originalname);
    const filename = (type === "pdf" ? "pdf-" : "excel-") + Date.now() + ext;
    const out = path.join(dir, filename);


    try {
        fs.copyFileSync(file.path, out);
        fs.unlinkSync(file.path);
    } catch (e) {
        console.error("DOCUMENT SAVE ERROR =>", e);
        throw e;
    }

    return {
        type: type,
        url: `/uploads/chat/${type}/` + filename,
        mimeType: file.mimetype,
        size: fs.statSync(out).size
    };
}


async function optimizeImage(file) {
    ensureDir(IMAGE_DIR);

    const out = path.join(IMAGE_DIR, "img-" + Date.now() + ".jpg");

    try {
        await sharp(file.path)
            .resize({ width: 1280, withoutEnlargement: true })
            .jpeg({ quality: 75 })
            .toFile(out);

    } catch (e) {
        throw e;
    }

    fs.unlinkSync(file.path);

    return {
        type: "image",
        url: "/uploads/chat/images/" + path.basename(out),
        mimeType: "image/jpeg",
        size: fs.statSync(out).size
    };
}


function optimizeVideo(file) {
    ensureDir(VIDEO_DIR);

    return new Promise((resolve, reject) => {
        const out = path.join(VIDEO_DIR, "vid-" + Date.now() + ".mp4");

        ffmpeg(file.path)
            .on("start", cmd => console.log("FFMPEG CMD =>", cmd))
            .on("end", () => {
                fs.unlinkSync(file.path);

                resolve({
                    type: "video",
                    url: "/uploads/chat/videos/" + path.basename(out),
                    mimeType: "video/mp4",
                    size: fs.statSync(out).size
                });
            })
            .on("error", err => {
                console.error("FFMPEG ERROR =>", err);
                reject(err);
            })
            .save(out);
    });
}


exports.processMedia = async (file) => {
    if (file.mimetype.startsWith("image/")) return optimizeImage(file);
    if (file.mimetype.startsWith("video/")) return optimizeVideo(file);
    if (file.mimetype === "application/pdf") return saveDocument(file, "pdf");
    if (
        file.mimetype === "application/vnd.ms-excel" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
        return saveDocument(file, "excel");
    }

    throw new Error("Unsupported file");
};

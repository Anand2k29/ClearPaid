// Uploads images to Cloudinary using an UNSIGNED upload preset, so no API secret is needed.
// Usage:
//   CLOUDINARY_CLOUD_NAME=your-cloud CLOUDINARY_UPLOAD_PRESET=your-preset node scripts/upload-images.js <file> [file...]
// Writes the resulting addresses to process/cloudinary-urls.json (the process folder is git-ignored).
const fs = require("node:fs");
const path = require("node:path");

const cloud = process.env.CLOUDINARY_CLOUD_NAME;
const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
const files = process.argv.slice(2);

if (!cloud || !preset) {
  console.error("Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET first (see the README).");
  process.exit(1);
}
if (!files.length) {
  console.error("Give at least one image file to upload.");
  process.exit(1);
}

async function upload(file) {
  const bytes = fs.readFileSync(file);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(file));
  form.append("upload_preset", preset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(`${file}: ${data.error ? data.error.message : res.status}`);
  return { file: path.basename(file), url: data.secure_url, publicId: data.public_id, bytes: data.bytes };
}

(async () => {
  const results = {};
  for (const file of files) {
    process.stdout.write(`Uploading ${path.basename(file)} ... `);
    try {
      const r = await upload(file);
      results[path.basename(file)] = r.url;
      console.log(`done (${Math.round(r.bytes / 1024)} KB)`);
    } catch (err) {
      console.log("failed");
      console.error(err.message);
    }
  }
  const out = path.join(__dirname, "..", "process", "cloudinary-urls.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nAddresses saved to ${out}`);
  console.log(JSON.stringify(results, null, 2));
})();

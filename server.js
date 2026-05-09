const fetch = require("node-fetch");
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();
app.use(express.static(__dirname));
app.use(express.json());

const IMAGE_DIR = path.join(__dirname, "images");

// ---- Multer: dynamic destination based on city ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const city = req.params.city;
    const dir = path.join(IMAGE_DIR, city);
    if (!fs.existsSync(dir)) {
      return cb(new Error(`City folder "${city}" does not exist`), null);
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ---- Geocode helpers ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const KNOWN_COORDS = {
  "Edinburgh":    { lat: 55.9533, lng: -3.1883 },
  "Glasgow":      { lat: 55.8642, lng: -4.2518 },
  "Inverness":    { lat: 57.4778, lng: -4.2247 },
  "Aberdeen":     { lat: 57.1497, lng: -2.0943 },
  "Dundee":       { lat: 56.4620, lng: -2.9707 },
  "Stirling":     { lat: 56.1165, lng: -3.9369 },
  "Perth":        { lat: 56.3950, lng: -3.4305 },
  "Fort William": { lat: 56.8198, lng: -5.1052 },
  "St Andrews":   { lat: 56.3398, lng: -2.7967 }
};

const CACHE_FILE = path.join(__dirname, "geocode-cache.json");
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function geocode(place) {
  await sleep(1000);
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ", Scotland")}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "ScotlandTravelMap/1.0" }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

async function geocodeCached(place, cache) {
  if (KNOWN_COORDS[place]) return KNOWN_COORDS[place];
  if (cache[place]) return cache[place];
  const result = await geocode(place);
  if (result) { cache[place] = result; saveCache(cache); }
  return result;
}

function generateTags(attractions) {
  const keywords = ["Castle","Museum","Beach","Golf","Cathedral","Whisky",
    "University","Waterfront","Hiking","Palace","Loch","Glen","Monument","Gallery","Park"];
  const found = new Set();
  attractions.forEach(a => keywords.forEach(k => {
    if (a.name.toLowerCase().includes(k.toLowerCase())) found.add(k);
  }));
  return [...found].slice(0, 5);
}

// ============================================================
//  API ROUTES
// ============================================================

// GET /api/data — all cities + attractions
app.get("/api/data", async (req, res) => {
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR);

  const cache = loadCache();
  const cities = [];
  const attractions = [];

  const cityFolders = fs.readdirSync(IMAGE_DIR).filter(name => {
    const fullPath = path.join(IMAGE_DIR, name);
    return fs.statSync(fullPath).isDirectory() && !name.startsWith(".");
  });

  for (const cityName of cityFolders) {
    const cityCoords = await geocodeCached(cityName, cache);
    if (!cityCoords) { console.warn(`Could not geocode: ${cityName}`); continue; }

    const city = {
      id: cityName.toLowerCase().replace(/\s+/g, "_"),
      name: cityName,
      lat: cityCoords.lat,
      lng: cityCoords.lng,
      desc: "",
      tags: [],
      attractions: []
    };

    const cityFolder = path.join(IMAGE_DIR, cityName);
    const files = fs.readdirSync(cityFolder).filter(f => !f.startsWith("."));

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (![".jpg",".jpeg",".png",".webp"].includes(ext)) continue;

      const attractionName = path.basename(file, ext)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());

      const attractionCoords = await geocodeCached(attractionName, cache);

      const attraction = {
        id: file,
        city: city.id,
        name: attractionName,
        img: `/images/${encodeURIComponent(cityName)}/${encodeURIComponent(file)}`,
        lat: attractionCoords?.lat ?? cityCoords.lat,
        lng: attractionCoords?.lng ?? cityCoords.lng
      };

      city.attractions.push(attraction);
      attractions.push(attraction);
    }

    city.tags = generateTags(city.attractions);
    cities.push(city);
  }

  res.json({ cities, attractions });
});

// GET /api/folders — folder/file listing for the admin panel
app.get("/api/folders", (req, res) => {
  if (!fs.existsSync(IMAGE_DIR)) return res.json([]);

  const result = fs.readdirSync(IMAGE_DIR)
    .filter(name => {
      const p = path.join(IMAGE_DIR, name);
      return fs.statSync(p).isDirectory() && !name.startsWith(".");
    })
    .map(cityName => {
      const cityFolder = path.join(IMAGE_DIR, cityName);
      const files = fs.readdirSync(cityFolder)
        .filter(f => !f.startsWith(".") && [".jpg",".jpeg",".png",".webp"]
          .includes(path.extname(f).toLowerCase()))
        .map(file => ({
          name: file,
          url: `/images/${encodeURIComponent(cityName)}/${encodeURIComponent(file)}`
        }));
      return { city: cityName, files };
    });

  res.json(result);
});

// POST /api/city — create a new city folder
app.post("/api/city", (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "City name required" });

  const folderName = name.trim();
  const folderPath = path.join(IMAGE_DIR, folderName);

  if (fs.existsSync(folderPath)) {
    return res.status(409).json({ error: `City "${folderName}" already exists` });
  }

  fs.mkdirSync(folderPath, { recursive: true });
  res.json({ success: true, city: folderName });
});

// POST /api/upload/:city — upload images to a city
app.post("/api/upload/:city", (req, res) => {
  upload.array("images", 20)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const uploaded = req.files.map(f => ({
      name: f.originalname,
      url: `/images/${encodeURIComponent(req.params.city)}/${encodeURIComponent(f.originalname)}`
    }));
    res.json({ success: true, files: uploaded });
  });
});

// DELETE /api/image/:city/:file — delete an image
app.delete("/api/image/:city/:file", (req, res) => {
  const filePath = path.join(IMAGE_DIR, req.params.city, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// Serve images statically
app.use("/images", express.static(IMAGE_DIR));

app.listen(3001, () => {
  console.log(`\n✅ Server running at http://localhost:3001`);
  console.log(`📁 Images folder: ${IMAGE_DIR}`);
});
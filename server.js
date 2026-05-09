process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const streamifier = require("streamifier");
const fetch = require("node-fetch");

const app = express();
app.use(express.static(__dirname));
app.use(express.json());

// --- CONFIGURATION ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Database Connected"));

const upload = multer({ storage: multer.memoryStorage() });

// --- SCHEMA ---
const CitySchema = new mongoose.Schema({
  id: String,
  name: String,
  lat: Number,
  lng: Number,
  tags: [String],
  attractions: [{
    name: String,
    description: String,
    img: String,
    isTicketed: Boolean,
    price: Number,
    hours: { open: String, close: String },
    tags: [String],
    lat: Number,  // ← add these
    lng: Number 
  }]
});
const City = mongoose.model("City", CitySchema);

// --- HELPERS ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function geocode(place) {
  await sleep(1000);
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ", Scotland")}&limit=1&featuretype=settlement`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "ScotlandTravelPlanner_v1.0" } });
    const data = await res.json();
    if (data && data.length > 0) {
      console.log(`Found ${place} at: ${data[0].lat}, ${data[0].lon}`);
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } else {
      console.warn(`Geocoder found nothing for: ${place}`);
      return null;
    }
  } catch(e) {
    console.error("Geocoding error:", e.message);
    return null;
  }
}

function generateTags(attractions) {
  const keywords = ["Castle","Museum","Beach","Golf","Cathedral","Whisky",
    "University","Waterfront","Hiking","Palace","Monument","Gallery","Park"];
  const found = new Set();
  attractions.forEach(a => {
    const text = (a.name + " " + (a.description || "")).toLowerCase();
    keywords.forEach(k => { if (text.includes(k.toLowerCase())) found.add(k); });
  });
  return [...found].slice(0, 5);
}

// --- ROUTES ---

app.get("/api/data", async (req, res) => {
  try {
    const cities = await City.find();
    res.json({ cities });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/city", async (req, res) => {
  try {
    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: "City name required" });

    const existing = await City.findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
    if (existing) return res.status(409).json({ error: `"${name}" already exists` });

    let coords = await geocode(name);
    if (!coords) coords = { lat: 56.4907, lng: -4.2026 }; // fallback: centre of Scotland

    const newCity = new City({
      id: name.toLowerCase().replace(/\s+/g, "_"),
      name,
      lat: coords.lat,
      lng: coords.lng,
      tags: [],
      attractions: []
    });

    await newCity.save();
    console.log(`✅ City added: ${name}`);
    res.json({ success: true });
  } catch(err) {
    console.error("Add city error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload/:cityId", upload.single("image"), async (req, res) => {
  try {
    const city = await City.findOne({ id: req.params.cityId });
    if (!city) return res.status(404).json({ error: "City not found" });
    if (!req.file) return res.status(400).json({ error: "No image file received" });

    console.log("File received:", req.file.originalname, req.file.size, "bytes");

    const streamUpload = (req) => new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "scotland_map" },
        (error, result) => error ? reject(error) : resolve(result)
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const cloudResult = await streamUpload(req);
    const attrCoords = await geocode(req.body.name);
    city.attractions.push({
      name: req.body.name,
      description: req.body.description,
      img: cloudResult.secure_url,
      isTicketed: req.body.isTicketed === "true",
      price: parseFloat(req.body.price) || 0,
      hours: { open: req.body.openTime, close: req.body.closeTime },
      tags: req.body.tags ? req.body.tags.split(",").map(t => t.trim()) : [],
      lat:         attrCoords?.lat ?? city.lat,  // ← falls back to city if not found
      lng:         attrCoords?.lng ?? city.lng
    });

    city.tags = generateTags(city.attractions);
    await city.save();

    console.log(`✅ Attraction "${req.body.name}" added to ${city.name}`);
    res.json({ success: true });
  } catch(err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/edit-attraction", async (req, res) => {
  try {
    const { cityId, attractionId, name, description, isTicketed, price, openTime, closeTime, closedDays, tags } = req.body;
    const city = await City.findOne({ id: cityId });
    if (!city) return res.status(404).json({ error: "City not found" });

    const attr = city.attractions.id(attractionId);
    if (!attr) return res.status(404).json({ error: "Attraction not found" });
    const attrCoords = await geocode(name);
    attr.name        = name;
    attr.description = description;
    attr.isTicketed  = isTicketed;
    attr.price       = parseFloat(price) || 0;
    attr.hours       = { open: openTime, close: closeTime, closedDays };
    attr.tags        = tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : [];
    attr.lat = attrCoords?.lat ?? city.lat;
    attr.lng = attrCoords?.lng ?? city.lng;

    city.tags = generateTags(city.attractions);
    await city.save();
    res.json({ success: true });
  } catch(err) {
    console.error("Edit attraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/delete-attraction", async (req, res) => {
  try {
    await City.findOneAndUpdate(
      { id: req.body.cityId },
      { $pull: { attractions: { _id: req.body.attractionId } } }
    );
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
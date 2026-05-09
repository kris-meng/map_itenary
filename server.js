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

const storage = multer.memoryStorage();
const upload = multer({ storage });

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
        tags: [String]
    }]
});
const City = mongoose.model("City", CitySchema);

// --- HELPERS (Your Logic) ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KNOWN_COORDS = {
  "Edinburgh": { lat: 55.9533, lng: -3.1883 },
  "Glasgow": { lat: 55.8642, lng: -4.2518 }
};

async function geocode(place) {
  await sleep(1000); // Respect rate limits
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ", Scotland")}`;
  const res = await fetch(url, { headers: { "User-Agent": "ScotlandTravelMap/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function generateTags(attractions) {
  const keywords = ["Castle","Museum","Beach","Golf","Cathedral","Whisky","University","Waterfront","Hiking","Palace","Monument","Gallery","Park"];
  const found = new Set();
  attractions.forEach(a => {
    const combinedText = (a.name + " " + (a.description || "")).toLowerCase();
    keywords.forEach(k => {
      if (combinedText.includes(k.toLowerCase())) found.add(k);
    });
  });
  return [...found].slice(0, 5);
}

// --- ROUTES ---

app.get("/api/data", async (req, res) => {
    const cities = await City.find();
    res.json({ cities });
});

// ADD CITY (With Automatic Geocoding)
app.post("/api/city", async (req, res) => {
    const name = req.body.name;
    
    // Check known coords first, then hit API
    let coords = KNOWN_COORDS[name] || await geocode(name);
    
    // Fallback if geocode fails
    if (!coords) coords = { lat: 56.4907, lng: -4.2026 };

    const newCity = new City({
        id: name.toLowerCase().replace(/\s+/g, "_"),
        name: name,
        lat: coords.lat,
        lng: coords.lng,
        tags: ["Exploring"],
        attractions: []
    });
    
    await newCity.save();
    res.json({ success: true });
});

// SAVE ATTRACTION (Fixed saving + Auto-Tags)
app.post("/api/upload/:cityId", upload.single("image"), async (req, res) => {
    try {
        const city = await City.findOne({ id: req.params.cityId });
        if (!city) return res.status(404).json({ error: "City not found" });

        // Stream to Cloudinary
        let streamUpload = (req) => {
            return new Promise((resolve, reject) => {
                let stream = cloudinary.uploader.upload_stream(
                    { folder: "scotland_map" },
                    (error, result) => { result ? resolve(result) : reject(error); }
                );
                streamifier.createReadStream(req.file.buffer).pipe(stream);
            });
        };

        const cloudResult = await streamUpload(req);

        // Add the new attraction
        city.attractions.push({
            name: req.body.name,
            description: req.body.description,
            img: cloudResult.secure_url,
            isTicketed: req.body.isTicketed === 'true',
            price: parseFloat(req.body.price) || 0,
            hours: { open: req.body.openTime, close: req.body.closeTime },
            tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : []
        });

        // RE-GENERATE CITY TAGS AUTOMATICALLY
        city.tags = generateTags(city.attractions);

        await city.save(); // Save the whole city object with the new attraction
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

app.post("/api/delete-attraction", async (req, res) => {
    await City.findOneAndUpdate({ id: req.body.cityId }, { $pull: { attractions: { _id: req.body.attractionId } } });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
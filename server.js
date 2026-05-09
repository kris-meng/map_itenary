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

async function geocode(place) {
    // We must wait 1 second because Nominatim (OSM) blocks rapid requests
    await sleep(1000);
    
    // We use 'featuretype=settlement' to ensure we get the actual city/town, not a street or shop
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ", Scotland")}&limit=1&featuretype=settlement`;
    
    try {
        const res = await fetch(url, { 
            headers: { 
                // A specific User-Agent prevents being identified as a "bot" and getting fake data
                "User-Agent": "ScotlandTravelPlanner_RealCoords_v1.0" 
            } 
        });
        const data = await res.json();
        
        if (data && data.length > 0) {
            console.log(`Found ${cityName} at: ${data[0].lat}, ${data[0].lon}`);
            return {
                lat: parseFloat(data[0].lat),
                lng: parseFloat(data[0].lon)
            };
        } else {
            console.warn(`Geocoder found nothing for: ${cityName}`);
            return null;
        }
    } catch (e) {
        console.error("Geocoding API Error:", e);
        return null;
    }
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
    let coords = await geocode(name);
    
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

        // ✅ Check file actually arrived
        if (!req.file) return res.status(400).json({ error: "No image file received" });

        console.log("File received:", req.file.originalname, req.file.size, "bytes");
        console.log("Body:", req.body);

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
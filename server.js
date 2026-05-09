require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2; 
const multer = require("multer");
const streamifier = require("streamifier"); 

const app = express();
app.use(express.static(__dirname));
app.use(express.json());

// 1. Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

// 2. Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Database Connected"))
  .catch(err => console.log("❌ DB Error:", err));

// 3. Multer Setup (Using Memory - NOT folders)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// 4. Database Schema
const CitySchema = new mongoose.Schema({
    id: String, name: String, lat: Number, lng: Number,
    attractions: [{
        name: String, description: String, img: String,
        isTicketed: Boolean, price: Number,
        hours: { open: String, close: String, closedDays: String },
        tags: [String]
    }]
});
const City = mongoose.model("City", CitySchema);

// --- API ROUTES ---

app.get("/api/data", async (req, res) => {
    const cities = await City.find();
    res.json({ cities });
});

app.post("/api/city", async (req, res) => {
    const name = req.body.name;
    const newCity = new City({
        id: name.toLowerCase().replace(/\s+/g, "_"),
        name: name,
        lat: 56.4 + (Math.random() * 0.5),
        lng: -4.2 + (Math.random() * 0.5),
        attractions: []
    });
    await newCity.save();
    res.json({ success: true });
});

// 5. OFFICIAL UPLOAD ROUTE
app.post("/api/upload/:cityId", upload.single("image"), async (req, res) => {
    const city = await City.findOne({ id: req.params.cityId });
    if (!city) return res.status(404).send("City not found");

    // This function converts the image in your RAM to a format Cloudinary understands
    let streamUpload = (req) => {
        return new Promise((resolve, reject) => {
            let stream = cloudinary.uploader.upload_stream(
                { folder: "scotland_map" },
                (error, result) => {
                    if (result) {
                        resolve(result);
                    } else {
                        reject(error);
                    }
                }
            );
            streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
    };

    try {
        const result = await streamUpload(req);
        
        city.attractions.push({
            name: req.body.name,
            description: req.body.description,
            img: result.secure_url, 
            isTicketed: req.body.isTicketed === 'true',
            price: parseFloat(req.body.price) || 0,
            hours: { 
                open: req.body.openTime, 
                close: req.body.closeTime,
                closedDays: req.body.closedDays 
            },
            tags: req.body.tags ? req.body.tags.split(',') : []
        });

        await city.save();
        res.json({ success: true });
    } catch (error) {
        console.error("Cloudinary Error:", error);
        res.status(500).json({ error: "Upload failed" });
    }
});

app.post("/api/delete-attraction", async (req, res) => {
    await City.findOneAndUpdate({ id: req.body.cityId }, { $pull: { attractions: { _id: req.body.attractionId } } });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
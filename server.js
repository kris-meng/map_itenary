require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
const app = express();

app.use(express.static(__dirname));
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("Database Connected"));

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

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'scotland_map' },
});
const upload = multer({ storage });

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

app.post("/api/upload/:cityId", upload.single("image"), async (req, res) => {
    const city = await City.findOne({ id: req.params.cityId });
    const attractionData = {
        name: req.body.name,
        description: req.body.description,
        img: req.file.path,
        isTicketed: req.body.isTicketed === 'true',
        price: parseFloat(req.body.price) || 0,
        hours: { open: req.body.openTime, close: req.body.closeTime, closedDays: req.body.closedDays },
        tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : []
    };
    city.attractions.push(attractionData);
    await city.save();
    res.json({ success: true });
});

app.post("/api/delete-attraction", async (req, res) => {
    await City.findOneAndUpdate({ id: req.body.cityId }, { $pull: { attractions: { _id: req.body.attractionId } } });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
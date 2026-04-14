const express = require("express");
const University = require("../models/University");

const router = express.Router();

// Get all universities
router.get("/", async (req, res) => {
  try {
    const universities = await University.find();
    res.json(universities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed universities
router.post("/seed", async (req, res) => {
  const uniNames = [
    "NED University",
    "Mehran University",
    "Quaid Awam University",
    "Karachi University",
    "Sir Syed University",
    "Dawood University",
    "NUST University",
    "FAST University",
    "GC University",
    "Habib University"
  ];

  try {
    const created = await University.insertMany(
      uniNames.map(name => ({ name })),
      { ordered: false }
    );
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

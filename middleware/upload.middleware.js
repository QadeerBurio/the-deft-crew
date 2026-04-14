const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.fieldname === "logo") cb(null, "uploads/brands");
    else if (file.fieldname === "image") cb(null, "uploads/offers");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

module.exports = multer({ storage });

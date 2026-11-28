const mongoose = require("mongoose");
const { SafetyReport } = require("../models/SafetyReport");
const SafetyReportRate = require("../models/SafetyReportRate");

async function main() {
  if (!process.env.MONGO_URI) throw new Error("Set MONGO_URI for the intended environment.");
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    await SafetyReport.createIndexes();
    await SafetyReportRate.createIndexes();
    console.log("Safety report indexes are ready.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("Could not initialize safety report indexes:", error.name);
  process.exitCode = 1;
});

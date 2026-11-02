// services/jobArchive.js
// Jobs are archived, never deleted: active: false plus archivedAt / archivedReason / archivedBy (models/Job).
// The job and its applications (and applicants' resume files) stay for the hiring history; archived jobs
// are hidden from every list.
const Job = require("../models/Job");

const PAKISTAN = /pakistan|karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|gujranwala|hyderabad|abbottabad|sargodha|bahawalpur|sukkur|larkana|gujrat|sheikhupura|jhelum|sahiwal|pk/i;

// imported jobs (isExternal, no employer) whose location is outside Pakistan; run at startup
async function archiveForeignImportedJobs(now = new Date()) {
  const imported = { isExternal: true, postedBy: null, archivedAt: null };
  const checked = await Job.countDocuments(imported);
  const r = await Job.updateMany(
    { ...imported, location: { $not: PAKISTAN } },
    { $set: { active: false, archivedAt: now, archivedReason: "outside-pakistan" } }
  );
  return { checked, archived: r.modifiedCount || 0 };
}

// one job (DELETE /jobs/delete/:id)
async function archiveJob(jobId, byUserId) {
  return Job.findOneAndUpdate(
    { _id: jobId, archivedAt: null },
    { $set: { active: false, archivedAt: new Date(), archivedReason: "deleted", archivedBy: byUserId || null } },
    { new: true }
  );
}

module.exports = { archiveForeignImportedJobs, archiveJob, PAKISTAN };

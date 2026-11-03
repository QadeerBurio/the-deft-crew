// models/CareerInterview.js
// One interview of a job application (services/career/careerInterviewService.js). Times are stored in UTC
// with the time zone they were set in (Asia/Karachi by default). calendarUid stays the same for the
// interview's whole life; calendarSequence goes up on every reschedule / cancellation, so a calendar
// replaces the old slot instead of adding a second one. Its status mirrors the timeline events; the
// timeline (CareerApplicationEvent) is the record. One active interview per application.
const mongoose = require("mongoose");

const careerInterviewSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    timezone: { type: String, default: "Asia/Karachi" },
    mode: { type: String, enum: ["online", "in-person", "phone"], default: "online" },
    location: { type: String, default: "", maxlength: 300 },
    meetingLink: { type: String, default: "", maxlength: 500 },
    note: { type: String, default: "", maxlength: 1000 }, // for the candidate
    status: {
      type: String,
      enum: ["invited", "accepted", "declined", "reschedule_requested", "cancelled", "completed", "candidate_no_show_reported", "employer_no_show_reported", "disputed"],
      default: "invited",
    },
    active: { type: Boolean, default: true }, // invited / accepted / reschedule requested
    calendarUid: { type: String, required: true },
    calendarSequence: { type: Number, default: 0 },
    history: { type: [mongoose.Schema.Types.Mixed], default: [] }, // earlier slots { startsAt, endsAt, changedAt }
    responses: { type: [mongoose.Schema.Types.Mixed], default: [] }, // { response, message, at }
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
careerInterviewSchema.index({ application: 1 }, { unique: true, partialFilterExpression: { active: true } });
careerInterviewSchema.index({ employer: 1, startsAt: 1 });
careerInterviewSchema.index({ candidate: 1, startsAt: 1 });

module.exports = mongoose.models.CareerInterview || mongoose.model("CareerInterview", careerInterviewSchema);

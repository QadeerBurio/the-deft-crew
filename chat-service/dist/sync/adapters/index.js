"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adapters = void 0;
const scholarship_adapter_1 = require("./scholarship.adapter");
const jobs_adapter_1 = require("./jobs.adapter");
const offers_adapter_1 = require("./offers.adapter");
const events_adapter_1 = require("./events.adapter");
const universities_adapter_1 = require("./universities.adapter");
const packages_adapter_1 = require("./packages.adapter");
const templates_adapter_1 = require("./templates.adapter");
const sliders_adapter_1 = require("./sliders.adapter");
const skeleton_adapters_1 = require("./skeleton.adapters");
const resumes_adapter_1 = require("./resumes.adapter");
__exportStar(require("./adapter.interface"), exports);
exports.adapters = [
    new scholarship_adapter_1.ScholarshipAdapter(),
    new jobs_adapter_1.JobsAdapter(),
    new offers_adapter_1.OffersAdapter(),
    new events_adapter_1.EventsAdapter(),
    new universities_adapter_1.UniversitiesAdapter(),
    new packages_adapter_1.PackagesAdapter(),
    new templates_adapter_1.TemplatesAdapter(),
    new sliders_adapter_1.SlidersAdapter(),
    new skeleton_adapters_1.NotesAdapter(),
    new skeleton_adapters_1.BooksAdapter(),
    new skeleton_adapters_1.LecturesAdapter(),
    new skeleton_adapters_1.PapersAdapter(),
    new resumes_adapter_1.ResumesAdapter()
];
exports.default = exports.adapters;
//# sourceMappingURL=index.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
// Resolve log folder relative to current working directory (project root)
const logDirectory = path_1.default.resolve('logs');
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};
winston_1.default.addColors(colors);
const format = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.splat(), winston_1.default.format.json());
const transports = [
    new winston_1.default.transports.Console({
        level: 'warn',
        format: winston_1.default.format.combine(winston_1.default.format.colorize({ all: true }), winston_1.default.format.printf((info) => `[${info.timestamp}] [${info.level}]: ${info.message}`)),
    }),
    new winston_1.default.transports.File({
        filename: path_1.default.join(logDirectory, 'error.log'),
        level: 'error',
    }),
    new winston_1.default.transports.File({
        filename: path_1.default.join(logDirectory, 'combined.log'),
    }),
];
exports.logger = winston_1.default.createLogger({
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    levels,
    format,
    transports,
});
exports.default = exports.logger;
//# sourceMappingURL=logger.js.map
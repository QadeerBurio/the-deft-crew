"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = exports.backendDbConnection = exports.aiDbConnection = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const envValidator_1 = require("./envValidator");
const logger_1 = require("./logger");
exports.aiDbConnection = mongoose_1.default.createConnection(envValidator_1.env.MONGO_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/The_deft_crew_Ai_assistant', {
    dbName: 'The_deft_crew_Ai_assistant',
});
const connectDB = async () => {
    try {
        exports.backendDbConnection = mongoose_1.default.connection;
        await exports.aiDbConnection.asPromise();
        logger_1.logger.info('✅ Chat Service connected successfully to dedicated AI database.');
    }
    catch (error) {
        logger_1.logger.error('❌ Failed to establish connection to database: ', error);
        throw error;
    }
};
exports.connectDB = connectDB;
exports.default = exports.connectDB;
//# sourceMappingURL=db.js.map
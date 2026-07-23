"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
const zod_1 = require("zod");
const ApiError_1 = require("../utils/ApiError");
const validate = (schema) => {
    return async (req, _res, next) => {
        try {
            const parsed = await schema.parseAsync({
                body: req.body,
                query: req.query,
                params: req.params,
            });
            // Re-assign parsed inputs to request for safety & typing if validated in schema
            if (parsed.body !== undefined) {
                req.body = parsed.body;
            }
            if (parsed.query !== undefined) {
                req.query = parsed.query;
            }
            if (parsed.params !== undefined) {
                req.params = parsed.params;
            }
            next();
        }
        catch (error) {
            if (error instanceof zod_1.ZodError) {
                // Build clear validation feedback
                const errorDetails = error.errors.map((err) => ({
                    field: err.path.slice(1).join('.'), // Remove top-level body/query/params key
                    message: err.message,
                }));
                next(new ApiError_1.ApiError(400, 'Validation Failed', errorDetails));
            }
            else {
                next(error);
            }
        }
    };
};
exports.validate = validate;
exports.default = exports.validate;
//# sourceMappingURL=validate.middleware.js.map
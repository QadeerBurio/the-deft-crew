export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details: any;

  constructor(statusCode: number, message: string, details: any = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;

    // Set the prototype explicitly to maintain class hierarchy
    Object.setPrototypeOf(this, new.target.prototype);

    Error.captureStackTrace(this, this.constructor);
  }
}

export default ApiError;

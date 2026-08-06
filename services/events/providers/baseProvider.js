/**
 * BaseProvider.js
 * Abstract Base Class for Event Providers
 */
class BaseProvider {
  constructor(name, config = {}) {
    if (new.target === BaseProvider) {
      throw new TypeError("Cannot instantiate abstract class BaseProvider directly.");
    }
    this.name = name;
    this.config = config;
    this.enabled = config.enabled !== false;
    this.rateLimitMs = config.rateLimitMs || 500;
    this.timeoutMs = config.timeoutMs || 5000;
  }

  /**
   * Fetch events from the source provider. Must return an array of raw event objects.
   * @returns {Promise<Array>} Array of raw provider event objects
   */
  async fetchEvents() {
    throw new Error(`fetchEvents() method must be implemented by subclass ${this.name}`);
  }

  /**
   * Helper utility for retry delay
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Safe execution wrapper with exponential backoff & retry handling
   */
  async executeWithRetry(fn, retries = 3, delay = 2000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ [${this.name}] Attempt ${attempt}/${retries} failed: ${err.message}`);
        if (attempt < retries) {
          await this.sleep(delay * attempt);
        }
      }
    }
    throw lastError;
  }
}

module.exports = BaseProvider;

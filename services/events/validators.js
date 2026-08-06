class EventValidator {
  /**
   * Validate normalized event object before database insertion
   */
  validate(event) {
    const errors = [];

    if (!event.title || typeof event.title !== 'string' || event.title.trim().length === 0) {
      errors.push('Title is required and must be a non-empty string.');
    }

    if (!event.organizer || typeof event.organizer !== 'string' || event.organizer.trim().length === 0) {
      errors.push('Organizer is required.');
    }

    if (event.latitude !== null && (isNaN(event.latitude) || event.latitude < -90 || event.latitude > 90)) {
      errors.push('Latitude must be a valid number between -90 and 90.');
    }

    if (event.longitude !== null && (isNaN(event.longitude) || event.longitude < -180 || event.longitude > 180)) {
      errors.push('Longitude must be a valid number between -180 and 180.');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

module.exports = new EventValidator();

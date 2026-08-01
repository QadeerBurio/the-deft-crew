// services/codeGenerator.js
class CodeGenerator {
  /**
   * Generate a unique promo code
   */
  static generatePromoCode(brandName, discountPercentage) {
    const prefix = brandName.substring(0, 5).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Generate a reference code for QR
   */
  static generateQRReference(offerId, studentId = null) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    const offerPart = offerId.toString().substring(0, 6);
    return `${offerPart}${timestamp}${random}`;
  }
}

module.exports = CodeGenerator;
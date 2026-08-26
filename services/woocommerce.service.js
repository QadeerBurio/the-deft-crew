// services/woocommerce.service.js
const axios = require('axios');

class WooCommerceService {
  constructor(brand) {
    this.brand = brand;
    this.baseUrl = brand.websiteUrl?.replace(/\/$/, '');
    this.consumerKey = brand.wooConsumerKey;
    this.consumerSecret = brand.wooConsumerSecret;
    this.isConfigured = !!(this.baseUrl && this.consumerKey && this.consumerSecret);
  }

  async createCoupon(couponData) {
    if (!this.isConfigured) {
      return { success: false, reason: 'WooCommerce not configured' };
    }

    try {
      const url = `${this.baseUrl}/wp-json/wc/v3/coupons`;
      
      const response = await axios.post(url, {
        code: couponData.code,
        discount_type: couponData.discount_type || 'percent',
        amount: couponData.amount.toString(),
        individual_use: true,
        usage_limit: couponData.usage_limit || 1,
        date_expires: couponData.expiresAt?.toISOString() || null,
        description: couponData.description || 'Student discount via TDC',
        usage_limit_per_user: 1,
      }, {
        auth: {
          username: this.consumerKey,
          password: this.consumerSecret
        },
        timeout: 30000
      });

      return {
        success: true,
        couponId: response.data.id,
        data: response.data
      };
    } catch (error) {
      console.error('WooCommerce create coupon error:', error.message);
      return {
        success: false,
        reason: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  async getCoupon(code) {
    if (!this.isConfigured) {
      return null;
    }

    try {
      const url = `${this.baseUrl}/wp-json/wc/v3/coupons`;
      const response = await axios.get(url, {
        params: { code: code },
        auth: {
          username: this.consumerKey,
          password: this.consumerSecret
        },
        timeout: 30000
      });

      return response.data.length > 0 ? response.data[0] : null;
    } catch (error) {
      console.error('WooCommerce get coupon error:', error.message);
      return null;
    }
  }

  async deleteCoupon(couponId) {
    if (!this.isConfigured) {
      return null;
    }

    try {
      const url = `${this.baseUrl}/wp-json/wc/v3/coupons/${couponId}`;
      await axios.delete(url, {
        auth: {
          username: this.consumerKey,
          password: this.consumerSecret
        },
        timeout: 30000
      });

      return { success: true };
    } catch (error) {
      console.error('WooCommerce delete coupon error:', error.message);
      return { success: false, reason: error.message };
    }
  }

  async verifyCoupon(code) {
    const coupon = await this.getCoupon(code);
    if (!coupon) {
      return { valid: false, reason: 'Coupon not found' };
    }

    const now = new Date();
    const expiresAt = coupon.date_expires ? new Date(coupon.date_expires) : null;

    if (expiresAt && expiresAt < now) {
      return { valid: false, reason: 'Coupon expired' };
    }

    if (coupon.usage_limit && coupon.usage_count >= coupon.usage_limit) {
      return { valid: false, reason: 'Coupon usage limit reached' };
    }

    return {
      valid: true,
      coupon: coupon
    };
  }
}

module.exports = WooCommerceService;
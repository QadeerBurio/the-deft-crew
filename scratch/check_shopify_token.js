// scratch/check_shopify_token.js
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const connectDB = require('../config/db');
const User = require('../models/User');

// Helper to check token validity against Shopify Shop API
async function checkTokenValidity(storeDomain, token) {
  try {
    const url = `https://${storeDomain}/admin/api/2024-01/shop.json`;
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });
    if (response.status === 200) {
      return { valid: true, shop: response.data.shop };
    }
  } catch (err) {
    return {
      valid: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    };
  }
  return { valid: false };
}

// Request new Shopify access token via Client Credentials flow
async function requestNewToken(storeDomain, clientId, clientSecret) {
  try {
    const url = `https://${storeDomain}/admin/oauth/access_token`;
    const response = await axios.post(url, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    });
    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    };
  }
}

async function runCheck() {
  console.log('🧪 Starting Shopify Access Token Check...');
  try {
    try {
      await connectDB();
      console.log('✅ DB Connected');

      // 1. Get all brand users who have Shopify fields populated or platform configured
      const brands = await User.find({
        $or: [
          { platform: 'shopify' },
          { shopifyStoreUrl: { $ne: '' } },
          { shopifyAccessToken: { $ne: '' } }
        ]
      });

      console.log(`📊 Found ${brands.length} brand users with Shopify configuration in the database.`);

      // Helper to format store domain
      const getStoreDomain = (shopUrl) => {
        const clean = shopUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
        return clean.includes(".") ? clean : `${clean}.myshopify.com`;
      };

      // Check DB brands
      for (const brand of brands) {
        console.log(`\n--- Checking Brand User: ${brand.name} (ID: ${brand._id}) ---`);
        const storeDomain = getStoreDomain(brand.shopifyStoreUrl || process.env.SHOPIFY_SHOP);
        console.log(`Domain: ${storeDomain}`);

        let token = brand.shopifyAccessToken;
        console.log(`Current DB Token: ${token ? `${token.substring(0, 8)}...` : 'None'}`);

        let checkResult = { valid: false };
        if (token) {
          checkResult = await checkTokenValidity(storeDomain, token);
        }

        if (checkResult.valid) {
          console.log(`✅ Current Token is ACTIVE! Shop Name: "${checkResult.shop.name}"`);
        } else {
          console.log(`❌ Current Token is EXPIRED or INVALID. Reason:`, checkResult.message || 'No token stored');
          
          const cId = brand.shopifyClientId || process.env.SHOPIFY_CLIENT_ID;
          const cSecret = brand.shopifyClientSecret || process.env.SHOPIFY_CLIENT_SECRET;

          if (cId && cSecret) {
            console.log('🔄 Attempting to request a new access token via Client Credentials...');
            const tokenReq = await requestNewToken(storeDomain, cId, cSecret);
            if (tokenReq.success) {
              const { access_token, expires_in } = tokenReq.data;
              console.log(`✅ Successfully requested a new token! New Token: ${access_token.substring(0, 8)}...`);
              
              // Save to DB
              brand.shopifyAccessToken = access_token;
              if (expires_in) {
                brand.shopifyTokenExpiresAt = new Date(Date.now() + (expires_in - 300) * 1000);
              }
              await brand.save();
              console.log('💾 New token and expiration saved to Database.');
            } else {
              console.log('❌ Failed to request a new token. Error details:', tokenReq.message, tokenReq.data || '');
            }
          } else {
            console.log('⚠️ Cannot request a new token: shopifyClientId or shopifyClientSecret is missing for this brand.');
          }
        }
      }
    } catch (dbErr) {
      console.warn('⚠️ Could not connect to MongoDB, skipping DB users check. Error:', dbErr.message);
    }

    // 2. Also check if there's any config in process.env / .env
    const envShop = process.env.SHOPIFY_SHOP || '';
    const envClientId = process.env.SHOPIFY_CLIENT_ID || '';
    const envClientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
    // Hardcoded token from the commented line in .env as a fallback test
    const envTokenFallback = "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"; 

    // Helper to format store domain
    const getStoreDomain = (shopUrl) => {
      const clean = shopUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return clean.includes(".") ? clean : `${clean}.myshopify.com`;
    };

    // Also test the .env credentials standalone if not covered
    if (envShop) {
      console.log(`\n--- Checking Standalone .env Config (${envShop}) ---`);
      const storeDomain = getStoreDomain(envShop);
      
      // Test the fallback token found in the .env comment
      console.log(`Testing token from .env comment: ${envTokenFallback.substring(0, 8)}...`);
      const fallbackCheck = await checkTokenValidity(storeDomain, envTokenFallback);
      if (fallbackCheck.valid) {
        console.log(`✅ Standalone fallback token is ACTIVE! Shop Name: "${fallbackCheck.shop.name}"`);
      } else {
        console.log(`❌ Standalone fallback token is EXPIRED or INVALID.`, fallbackCheck.message);
        if (envClientId && envClientSecret) {
          console.log('🔄 Attempting to request a new access token using .env Credentials...');
          const tokenReq = await requestNewToken(storeDomain, envClientId, envClientSecret);
          if (tokenReq.success) {
            console.log(`✅ Successfully requested a new token from Shopify using .env!`);
            console.log(`New Token: ${tokenReq.data.access_token}`);
            console.log(`Expires In: ${tokenReq.data.expires_in} seconds`);
          } else {
            console.log('❌ Failed to request new token using .env credentials:', tokenReq.message, tokenReq.data || '');
          }
        } else {
          console.log('⚠️ .env is missing client_id or client_secret.');
        }
      }
    }

    console.log('\n🏁 Shopify check finished.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Check failed with error:', err);
    process.exit(1);
  }
}

runCheck();

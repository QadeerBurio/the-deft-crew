// services/surplus/policy.js
// Surprise Box rules in one place (Sprint 5 decisions): pickup only, pay at pickup, 10-minute holds, at
// most 2 boxes per student per listing, one active order per student per brand, student cancels until
// 30 minutes before pickup starts (after that, not collecting is a no-show), brand cancels any time,
// disputes within 24 hours of pickup. No-shows are recorded, never auto-banned.

const HOLD_MINUTES = 10;
const MAX_PER_LISTING = 2;
const STUDENT_CANCEL_BEFORE_MIN = 30;
const DISPUTE_HOURS = 24;
const REMINDER_BEFORE_MIN = 30;
const EARLY_PICKUP_MIN = 30; // a code is accepted from 30 minutes before the window opens
const AUTO_COMPLETE_AFTER_MIN = 120; // verified but never marked paid: completed 2 hours after the window

const ACTIVE = ["ORDER_PLACED", "CONFIRMED", "PREPARING", "READY_FOR_PICKUP", "PICKUP_VERIFIED"];
const AWAITING_PICKUP = ["ORDER_PLACED", "CONFIRMED", "PREPARING", "READY_FOR_PICKUP"];
const TERMINAL = ["COMPLETED", "RESERVATION_EXPIRED", "MERCHANT_CANCELLED", "CUSTOMER_CANCELLED", "NO_SHOW", "DISPUTED", "SOLD_OUT"];

// what the brand may do from each state (server-side; the portal only shows these)
const MERCHANT_MOVES = {
  ORDER_PLACED: ["CONFIRMED", "MERCHANT_CANCELLED"],
  CONFIRMED: ["PREPARING", "READY_FOR_PICKUP", "MERCHANT_CANCELLED"],
  PREPARING: ["READY_FOR_PICKUP", "MERCHANT_CANCELLED"],
  READY_FOR_PICKUP: ["MERCHANT_CANCELLED"], // handover only through verify-pickup
  PICKUP_VERIFIED: ["COMPLETED"], // with "paid at pickup"
};
const merchantNext = (state) => MERCHANT_MOVES[state] || [];

const cancellationRule = () =>
  `Pay at pickup. You can cancel in the app until ${STUDENT_CANCEL_BEFORE_MIN} minutes before pickup starts; ` +
  "after that, not collecting counts as a no-show. The brand may cancel if the food isn't available; you'll be told.";
const cancelUntil = (pickupStart) => new Date(new Date(pickupStart).getTime() - STUDENT_CANCEL_BEFORE_MIN * 60000);

/** The food and pickup disclosures a student must see (and accepts) before confirming */
function disclosuresOf(listing) {
  return {
    contentsMayVary: listing.contentsMayVary !== false,
    contentsNote: listing.contentsMayVary !== false ? "Contents may vary: it's what the brand has left that day." : "Contents as described.",
    description: listing.description || "",
    allergens: listing.allergens || [],
    allergenNotes: listing.allergenNotes || "",
    allergenWarning: "Ask the brand at pickup if you have an allergy. Surplus food can't be guaranteed allergen-free.",
    dietary: listing.dietary || [],
    bestBefore: listing.bestBefore || null,
    pickupStart: listing.pickupStart,
    pickupEnd: listing.pickupEnd,
    payment: `Pay ${listing.currency || "PKR"} ${listing.price} per box at pickup. tdc doesn't take payment.`,
    cancellationRule: cancellationRule(),
    cancelUntil: cancelUntil(listing.pickupStart),
  };
}

const studentCanCancel = (order, now = new Date()) =>
  AWAITING_PICKUP.includes(order.state) && now.getTime() <= new Date(order.pickupStart).getTime() - STUDENT_CANCEL_BEFORE_MIN * 60000;

module.exports = {
  HOLD_MINUTES, MAX_PER_LISTING, STUDENT_CANCEL_BEFORE_MIN, DISPUTE_HOURS, REMINDER_BEFORE_MIN, EARLY_PICKUP_MIN, AUTO_COMPLETE_AFTER_MIN,
  ACTIVE, AWAITING_PICKUP, TERMINAL, MERCHANT_MOVES, merchantNext, disclosuresOf, cancellationRule, cancelUntil, studentCanCancel,
};

// backend/utils/deepLink.js
// Server-side mirror of the client deep-link builder

const SCHEME = 'tdcapp';
const WEB = 'https://the-deft-crew-production.up.railway.app';

const pickId = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v._id) return String(v._id);
  if (typeof v === 'object' && v.toString) return v.toString();
  return null;
};

function buildLink(type, refs = {}) {
  const postId = pickId(refs.postId);
  const conversationId = pickId(refs.conversationId);
  const senderId = pickId(refs.senderId);
  const eventId = pickId(refs.eventId);
  const offerId = pickId(refs.offerId);
  const listingId = pickId(refs.listingId);
  const matchId = pickId(refs.matchId);
  const threadId = pickId(refs.threadId);

  switch (type) {
    // ---------- SOCIAL ----------
    case 'like':
    case 'comment':
    case 'reply':
    case 'mention':
      if (postId)
        return { link: `${SCHEME}://post/${postId}`, webLink: `${WEB}/post/${postId}` };
      if (senderId)
        return { link: `${SCHEME}://user/${senderId}`, webLink: `${WEB}/user/${senderId}` };
      break;

    case 'message':
      if (conversationId)
        return {
          link: `${SCHEME}://chat/${conversationId}`,
          webLink: `${WEB}/chat/${conversationId}`,
        };
      break;

    case 'request':
    case 'connection_accepted':
    case 'request_declined':
      if (senderId)
        return { link: `${SCHEME}://user/${senderId}`, webLink: `${WEB}/user/${senderId}` };
      break;

    // ---------- EVENTS ----------
    case 'Event':
      if (eventId)
        return { link: `${SCHEME}://event/${eventId}`, webLink: `${WEB}/event/${eventId}` };
      break;

    // ---------- SKILLSHARE ----------
    case 'Offer':
      if (offerId)
        return { link: `${SCHEME}://offer/${offerId}`, webLink: `${WEB}/offer/${offerId}` };
      if (listingId)
        return { link: `${SCHEME}://listing/${listingId}`, webLink: `${WEB}/listing/${listingId}` };
      break;

    case 'Exchange':
      if (listingId)
        return { link: `${SCHEME}://listing/${listingId}`, webLink: `${WEB}/listing/${listingId}` };
      break;

    // ---------- SIMPLE SCREEN MAPS ----------
    case 'Brand':
      return { link: `${SCHEME}://brands`, webLink: `${WEB}/brands` };
    case 'Job Application':
    case 'Job Posting':
    case 'Application Status':
    case 'Interview':
      return { link: `${SCHEME}://jobs`, webLink: `${WEB}/jobs` };
    case 'Booking':
      return { link: `${SCHEME}://bookings`, webLink: `${WEB}/bookings` };
    case 'Card':
      return { link: `${SCHEME}://card`, webLink: `${WEB}/card` };
    case 'Payment':
      return { link: `${SCHEME}://payments`, webLink: `${WEB}/payments` };
    case 'Welcome':
      return { link: `${SCHEME}://home`, webLink: `${WEB}/home` };
  }

  // Fallback
  return { link: `${SCHEME}://notifications`, webLink: `${WEB}/notifications` };
}

module.exports = { buildLink };
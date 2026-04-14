const { Expo } = require('expo-server-sdk');
let expo = new Expo();

const sendPushNotification = async (targetToken, title, body) => {
  if (!Expo.isExpoPushToken(targetToken)) {
    console.error("Invalid Expo push token:", targetToken);
    return;
  }

  const messages = [{
    to: targetToken,
    sound: 'default',
    title: title,        // This shows in BOLD in the pop-up
    body: body,          // This shows below the title
    data: extraData,     // Hidden info (e.g., { screen: 'Offers' })
    priority: 'high',    // Forces the top-of-screen pop-up
    channelId: 'default',
  }];

  try {
    let chunks = expo.chunkPushNotifications(messages);
    for (let chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (error) {
    console.error("Error sending push:", error);
  }
};

module.exports = sendPushNotification;
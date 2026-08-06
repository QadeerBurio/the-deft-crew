/**
 * eventSocket.js
 * Socket.io events handler for real-time mobile app and admin updates
 */

let ioInstance = null;

module.exports = {
  init: (io) => {
    ioInstance = io;
    console.log('📡 [EventSocket] Socket.io event broadcaster initialized.');

    io.on('connection', (socket) => {
      socket.on('subscribe_events', () => {
        socket.join('events_room');
        console.log(`📱 Client ${socket.id} subscribed to live events feed room.`);
      });
    });
  },

  emitNewEventsImported: (count, events = []) => {
    if (!ioInstance) return;
    console.log(`📢 [EventSocket] Broadcasting "events:new_imported" (${count} new events)...`);
    ioInstance.emit('events:new_imported', {
      count,
      events,
      timestamp: new Date()
    });
  },

  emitEventsExpired: (count) => {
    if (!ioInstance) return;
    console.log(`📢 [EventSocket] Broadcasting "events:expired" (${count} expired events)...`);
    ioInstance.emit('events:expired', {
      count,
      timestamp: new Date()
    });
  },

  emitAdminSyncStatus: (statusData) => {
    if (!ioInstance) return;
    ioInstance.emit('events:admin_sync_status', statusData);
  }
};

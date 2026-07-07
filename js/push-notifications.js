/* js/push-notifications.js
   Handles the whole push-notification lifecycle inside the app:
   - Shows a soft in-app "Enable notifications" card before ever
     triggering the real OS permission dialog (so we don't burn the
     one-shot Android prompt on a cold, unexplained popup).
   - Registers the device with FCM and subscribes it to the
     "all_users" topic via our own backend function.
   - Saves every received notification into a local history
     (localStorage) so the bell/notifications page can show it.
   - On tap, navigates to the page path sent with the notification,
     or index.html if none was set.

   Include this with a plain <script> tag on every page (index.html,
   calculator.html) — NOT through RSMLoader, since it depends on the
   native plugin bundled into this specific APK build.
*/
(function () {
  'use strict';

  var LS_HISTORY_KEY = 'rsm-notif-history';
  var LS_ASKED_KEY = 'rsm-notif-permission-asked';
  var LS_SUBSCRIBED_KEY = 'rsm-notif-subscribed';
  var MAX_HISTORY = 50;

  // Running in a plain browser (no Capacitor / no native push plugin) —
  // skip everything below silently.
  if (typeof Capacitor === 'undefined' || !Capacitor.Plugins || !Capacitor.Plugins.PushNotifications) {
    return;
  }
  var PushNotifications = Capacitor.Plugins.PushNotifications;

  // ── Local history (for the bell / notifications page) ──────────
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY))); }
    catch (e) {}
  }
  function addToHistory(entry) {
    var list = getHistory();
    list.unshift({
      title: entry.title || '',
      body: entry.body || '',
      path: entry.path || '',
      sentAt: entry.sentAt || new Date().toISOString(),
      read: false
    });
    saveHistory(list);
    updateBellBadge();
  }
  function markAllRead() {
    var list = getHistory().map(function (n) { n.read = true; return n; });
    saveHistory(list);
    updateBellBadge();
  }

  function updateBellBadge() {
    var unread = getHistory().filter(function (n) { return !n.read; }).length;
    var badge = document.getElementById('bellBadge');
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // Exposed so notifications.html can read/update history without
  // duplicating this logic.
  window.RSMNotif = {
    getHistory: getHistory,
    markAllRead: markAllRead,
    updateBellBadge: updateBellBadge
  };

  // ── Bell icon click: checks permission before opening the page ──
  // - granted  → go straight to notifications.html
  // - denied   → Android won't re-show its own popup once denied, so
  //              jump straight to the phone's per-app notification
  //              settings screen instead (needs capacitor-native-settings)
  // - not yet asked → trigger the real OS permission prompt, then open
  //   notifications.html either way
  function openNotificationSettings() {
    var NativeSettings = Capacitor.Plugins.NativeSettings;
    if (NativeSettings) {
      NativeSettings.open({ optionAndroid: 'app_notification', optionIOS: 'app_notification' });
    } else {
      window.location.href = 'notifications.html'; // plugin not installed — fall back
    }
  }

  function handleBellClick(e) {
    e.preventDefault();
    PushNotifications.checkPermissions().then(function (res) {
      if (res.receive === 'granted') {
        window.location.href = 'notifications.html';
      } else if (res.receive === 'denied') {
        openNotificationSettings();
      } else {
        PushNotifications.requestPermissions().then(function (r) {
          if (r.receive === 'granted') PushNotifications.register();
          window.location.href = 'notifications.html';
        });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var bellLink = document.getElementById('bellLink');
    if (bellLink) bellLink.addEventListener('click', handleBellClick);
  });

  // ── Listeners (safe to (re)register on every page load) ─────────
  PushNotifications.addListener('registration', function (token) {
    if (localStorage.getItem(LS_SUBSCRIBED_KEY) === token.value) return; // already subscribed this exact token
    fetch('https://ssc-calculator-app.pages.dev/api/subscribe-topic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value })
    }).then(function (r) {
      if (r.ok) { try { localStorage.setItem(LS_SUBSCRIBED_KEY, token.value); } catch (e) {} }
    }).catch(function () { /* offline — will retry next app open since we didn't save the flag */ });
  });

  PushNotifications.addListener('registrationError', function (err) {
    console.warn('Push registration error', err);
  });

  // App open in foreground when a push arrives — just log it, no nav.
  PushNotifications.addListener('pushNotificationReceived', function (notification) {
    var data = notification.data || {};
    addToHistory({
      title: notification.title || data.title,
      body: notification.body || data.body,
      path: data.path,
      sentAt: data.sentAt
    });
  });

  // User tapped the notification from the tray — navigate.
  PushNotifications.addListener('pushNotificationActionPerformed', function (action) {
    var notif = action.notification || {};
    var data = notif.data || {};
    addToHistory({
      title: notif.title || data.title,
      body: notif.body || data.body,
      path: data.path,
      sentAt: data.sentAt
    });
    var target = (data.path && data.path.trim()) ? data.path.trim() : 'index.html';
    window.location.href = target;
  });

  // Reflect unread count on whichever page has a bell icon.
  updateBellBadge();

  // ── Permission flow ─────────────────────────────────────────────
  function requestRealPermission() {
    PushNotifications.requestPermissions().then(function (res) {
      if (res.receive === 'granted') {
        PushNotifications.register();
      }
    });
  }

  // Called by the "Enable notifications" in-app card's Allow button.
  window.RSMNotif.enableNotifications = function () {
    try { localStorage.setItem(LS_ASKED_KEY, '1'); } catch (e) {}
    requestRealPermission();
    var card = document.getElementById('notifPromptCard');
    if (card) card.remove();
  };

  window.RSMNotif.dismissPrompt = function () {
    try { localStorage.setItem(LS_ASKED_KEY, '1'); } catch (e) {}
    var card = document.getElementById('notifPromptCard');
    if (card) card.remove();
  };

  // If permission was already granted in a previous session (e.g. user
  // enabled it before, or Android <13 default-allow), just register
  // silently — no need to show the card again.
  PushNotifications.checkPermissions().then(function (res) {
    if (res.receive === 'granted') {
      PushNotifications.register();
      return;
    }
    // Not granted yet — only show the soft in-app card once, on a page
    // that has a #notifPromptSlot element (see index.html snippet).
    if (localStorage.getItem(LS_ASKED_KEY) === '1') return;
    var slot = document.getElementById('notifPromptSlot');
    if (!slot) return;
    slot.innerHTML =
      '<div class="card" id="notifPromptCard" style="display:flex;align-items:center;gap:12px;">' +
        '<div style="flex:1;">' +
          '<div style="font-weight:700;font-size:0.85rem;margin-bottom:2px;">Allow Notification</div>' +
          '<div style="font-size:0.74rem;color:var(--text-muted,#888);">to Get All Answer key related updates very fast</div>' +
        '</div>' +
        '<button onclick="RSMNotif.enableNotifications()" style="padding:8px 14px;border-radius:8px;background:#0f766e;color:#fff;border:none;font-weight:600;font-size:0.78rem;">Allow</button>' +
        '<button onclick="RSMNotif.dismissPrompt()" style="padding:8px 10px;border-radius:8px;background:transparent;border:none;color:var(--text-muted,#888);font-size:0.9rem;">✕</button>' +
      '</div>';
  });
})();


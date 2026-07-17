import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import webpush from 'web-push';

const APP_URL = 'https://littlemrbboy.github.io/mijn-app/';
const CATCH_UP_WINDOW_MINUTES = 15;

function getApp() {
  if (getApps().length) return getApps()[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  return initializeApp({ credential: cert(serviceAccount) });
}

function nowInTimeZone(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
    day: weekdayMap[parts.weekday],
    dateStr: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const db = getFirestore(getApp());
  webpush.setVapidDetails(
    'mailto:boazp.vanderiet@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const { minutes: nowMinutes, day, dateStr } = nowInTimeZone('Europe/Amsterdam');

  const routinesSnap = await db.collection('routines').where('enabled', '==', true).get();

  const due = routinesSnap.docs.filter(d => {
    const data = d.data();
    if (!Array.isArray(data.days) || !data.days.includes(day)) return false;
    if (data.lastSentDate === dateStr) return false;
    if (!data.time) return false;
    const routineMinutes = timeToMinutes(data.time);
    return routineMinutes <= nowMinutes && nowMinutes - routineMinutes <= CATCH_UP_WINDOW_MINUTES;
  });

  let sentCount = 0;
  for (const routineDoc of due) {
    const routine = routineDoc.data();
    const subsSnap = await db.collection('pushSubscriptions').where('uid', '==', routine.uid).get();

    const payload = JSON.stringify({
      title: routine.title,
      body: routine.note || 'Tijd voor je ritme-moment.',
      tag: `ritme-${routineDoc.id}`,
      url: APP_URL
    });

    for (const subDoc of subsSnap.docs) {
      const sub = subDoc.data().subscription;
      try {
        await webpush.sendNotification(sub, payload);
        sentCount++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await subDoc.ref.delete();
        } else {
          console.error('Push send failed', routineDoc.id, err.statusCode, err.message);
        }
      }
    }

    await routineDoc.ref.update({ lastSentDate: dateStr });
  }

  console.log(`Checked ${routinesSnap.size} routines, ${due.length} due, sent ${sentCount} notifications.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

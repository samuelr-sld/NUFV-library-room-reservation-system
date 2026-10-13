import { FieldValue } from 'firebase-admin/firestore';
import { audit } from './audit.js';

// Releases student-number locks whose owner's Firebase Auth account no longer exists (e.g. deleted by an administrator).
// Operator-run only (server/scripts/release-orphaned-locks.js); never reachable from a client. Dry run unless apply is true.
//
// A lock is released only when Auth answers "user-not-found" for its uid. Any other answer (account exists, disabled,
// network or quota error) keeps the lock. Uids are never reused, so a missing account cannot come back and reclaim it.
// The owner's profile is kept for history (marked "orphaned") and an audit entry is written in the same transaction.
export async function releaseOrphanedLocks({ auth, db, apply = false, operator = 'unknown' }) {
  const report = { checked: 0, kept: 0, orphaned: [], released: [], skipped: [] };

  for (const lock of (await db.collection('studentNumbers').get()).docs) {
    report.checked++;
    const uid = lock.get('uid');
    if (typeof uid !== 'string') {
      report.skipped.push({ studentNumber: lock.id, reason: 'malformed-lock' });
      continue;
    }

    try {
      await auth.getUser(uid);
      report.kept++;
      continue;
    } catch (err) {
      if (err.code !== 'auth/user-not-found') {
        report.skipped.push({ studentNumber: lock.id, reason: err.code ?? 'auth-error' });
        continue;
      }
    }
    report.orphaned.push({ studentNumber: lock.id, uid });
    if (!apply) continue;

    const outcome = await db.runTransaction(async (tx) => {
      const profileRef = db.doc(`users/${uid}`);
      const [current, profile] = await Promise.all([tx.get(lock.ref), tx.get(profileRef)]);
      if (!current.exists || current.get('uid') !== uid) return 'changed';
      if (profile.exists && profile.get('studentNumber') !== lock.id) return 'inconsistent-profile';
      if (profile.exists) tx.update(profileRef, { status: 'orphaned', orphanedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.delete(lock.ref);
      audit(db, tx, {
        actorUid: null, action: 'studentNumber.release', targetType: 'user', targetId: uid,
        details: { studentNumber: lock.id, hadProfile: profile.exists, operator },
      });
      return 'released';
    });
    if (outcome === 'released') report.released.push({ studentNumber: lock.id, uid });
    else report.skipped.push({ studentNumber: lock.id, reason: outcome });
  }
  return report;
}

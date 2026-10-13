import { FieldValue } from 'firebase-admin/firestore';

// Written inside the caller's transaction so the log exists if and only if the change commits.
export function audit(db, tx, { actorUid, action, targetType, targetId, details = null }) {
  tx.create(db.collection('auditLogs').doc(), {
    actorUid, action, targetType, targetId, details,
    at: FieldValue.serverTimestamp(),
  });
}

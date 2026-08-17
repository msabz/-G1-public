export const WIFI_P2P_STATUS = {
  CONNECTED: 0,
  INVITED: 1,
  FAILED: 2,
  AVAILABLE: 3,
  UNAVAILABLE: 4,
};

export const isPeerAvailable = peer => (
  Number(peer?.status) === WIFI_P2P_STATUS.AVAILABLE
);

const normalizedAddress = peer => (peer?.deviceAddress || '').toLowerCase();

export const sameWifiPeer = (a, b) => {
  if (!a || !b) {
    return false;
  }
  if (a.peerId && b.peerId && a.peerId === b.peerId) {
    return true;
  }
  const aAddress = normalizedAddress(a);
  return !!aAddress && aAddress === normalizedAddress(b);
};

/**
 * لا نجيب تلقائياً إلا دعوة معلّقة من جهة اتصال محفوظة. تطابق peerId يسمح
 * بقبول العنوان الجديد الذي أكده DNS-SD، من دون الاتصال التلقائي بجهاز غريب
 * لم يسبق للمستخدم اختياره.
 */
export const findTrustedIncomingInvitation = (peers, savedContacts) => {
  const contacts = savedContacts || [];
  return (peers || []).find(peer => (
    Number(peer?.status) === WIFI_P2P_STATUS.INVITED &&
    contacts.some(contact => sameWifiPeer(peer, contact))
  )) || null;
};

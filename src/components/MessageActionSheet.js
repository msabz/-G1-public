import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { messagePreview } from '../messaging/messageModel';

function messageTypeDetails(message) {
  switch (message?.type) {
    case 'image':
      return { icon: '▧', label: 'صورة' };
    case 'voice':
      return { icon: '◖', label: 'رسالة صوتية' };
    case 'file':
      return { icon: '▤', label: 'ملف' };
    case 'call':
      return { icon: '◉', label: 'سجل مكالمة' };
    default:
      return { icon: '✦', label: 'رسالة نصية' };
  }
}

export default function MessageActionSheet({
  visible,
  message,
  theme,
  onClose,
  onReply,
  onCopy,
  onShare,
  onDelete,
}) {
  const details = messageTypeDetails(message);
  const senderLabel = message?.sender === 'me' ? 'مرسلة منك' : 'واردة';
  const actions = [
    {
      key: 'reply',
      icon: '↩',
      label: 'رد',
      description: 'اقتباس الرسالة في ردك',
      accessibilityLabel: 'الرد على الرسالة',
      accessibilityHint: 'يضيف اقتباساً من الرسالة إلى حقل الكتابة',
      onPress: onReply,
    },
    {
      key: 'copy',
      icon: '⧉',
      label: 'نسخ',
      description: 'حفظ المحتوى في الحافظة',
      accessibilityLabel: 'نسخ الرسالة',
      accessibilityHint: 'ينسخ محتوى الرسالة إلى حافظة الجهاز',
      onPress: onCopy,
    },
    {
      key: 'share',
      icon: '↗',
      label: 'مشاركة',
      description: 'إرسالها إلى تطبيق آخر',
      accessibilityLabel: 'مشاركة الرسالة',
      accessibilityHint: 'يفتح قائمة تطبيقات المشاركة في النظام',
      onPress: onShare,
    },
    {
      key: 'delete',
      icon: '⌫',
      label: 'حذف محلي',
      description: 'من هذا الجهاز فقط',
      accessibilityLabel: 'حذف الرسالة محلياً',
      accessibilityHint: 'يحذف الرسالة من هذا الجهاز فقط بعد التأكيد',
      onPress: onDelete,
      destructive: true,
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      hardwareAccelerated
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <TouchableOpacity
          testID="message-actions-backdrop"
          style={[styles.backdrop, { backgroundColor: theme.overlay }]}
          activeOpacity={1}
          accessible={false}
          onPress={onClose}
        />

        <View
          testID="message-actions-sheet"
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <View style={[styles.grip, { backgroundColor: theme.border }]} />

          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text
                style={[styles.title, { color: theme.text }]}
                accessibilityRole="header"
              >
                خيارات الرسالة
              </Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
                {details.label} · {senderLabel}
              </Text>
            </View>
            <TouchableOpacity
              testID="message-actions-close"
              style={[styles.closeButton, { backgroundColor: theme.surfaceVariant }]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="إغلاق خيارات الرسالة"
              accessibilityHint="يغلق القائمة ويعود إلى المحادثة"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.closeIcon, { color: theme.textSecondary }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <View
            testID="message-actions-preview"
            style={[styles.preview, { backgroundColor: theme.surfaceVariant }]}
            accessible
            accessibilityLabel={`الرسالة المحددة: ${messagePreview(message)}`}
          >
            <View style={[styles.previewIcon, { backgroundColor: theme.surfaceSubtle }]}>
              <Text style={[styles.previewIconText, { color: theme.primary }]}>{details.icon}</Text>
            </View>
            <Text style={[styles.previewText, { color: theme.text }]} numberOfLines={2}>
              {messagePreview(message)}
            </Text>
          </View>

          <View style={styles.actionGrid}>
            {actions.map(action => {
              const actionColor = action.destructive ? theme.error : theme.primary;
              const enabled = typeof action.onPress === 'function';
              return (
                <TouchableOpacity
                  key={action.key}
                  testID={`message-action-${action.key}`}
                  style={[
                    styles.action,
                    {
                      backgroundColor: theme.surfaceSubtle,
                      borderColor: action.destructive ? theme.error : theme.border,
                      opacity: enabled ? 1 : 0.45,
                    },
                  ]}
                  activeOpacity={0.72}
                  disabled={!enabled}
                  onPress={action.onPress}
                  accessibilityRole="button"
                  accessibilityLabel={action.accessibilityLabel}
                  accessibilityHint={action.accessibilityHint}
                  accessibilityState={{ disabled: !enabled }}
                >
                  <View style={[styles.actionIcon, { backgroundColor: theme.surfaceVariant }]}>
                    <Text style={[styles.actionIconText, { color: actionColor }]}>{action.icon}</Text>
                  </View>
                  <View style={styles.actionCopy}>
                    <Text style={[styles.actionLabel, { color: actionColor }]}>{action.label}</Text>
                    <Text style={[styles.actionDescription, { color: theme.textSecondary }]}>
                      {action.description}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text
            testID="message-actions-local-delete-note"
            style={[styles.localDeleteNote, { color: theme.textMuted }]}
          >
            الحذف محلي ولا يزيل الرسالة من جهاز الطرف الآخر
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    direction: 'rtl',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
    elevation: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  grip: {
    width: 42,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    textAlign: 'right',
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '700',
  },
  subtitle: {
    textAlign: 'right',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 1,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
  },
  preview: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
    marginBottom: 14,
    gap: 10,
  },
  previewIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewIconText: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
  },
  previewText: {
    flex: 1,
    textAlign: 'right',
    writingDirection: 'auto',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  action: {
    minHeight: 80,
    flexGrow: 1,
    flexBasis: '47%',
    maxWidth: '49%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 11,
    paddingVertical: 10,
    gap: 9,
  },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconText: {
    fontSize: 21,
    lineHeight: 25,
    fontWeight: '700',
  },
  actionCopy: {
    flex: 1,
    minWidth: 0,
  },
  actionLabel: {
    textAlign: 'right',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  actionDescription: {
    textAlign: 'right',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
    writingDirection: 'rtl',
  },
  localDeleteNote: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 13,
    writingDirection: 'rtl',
  },
});

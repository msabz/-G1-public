import React from 'react';
import fs from 'fs';
import path from 'path';
import renderer, { act } from 'react-test-renderer';
import MessageActionSheet from '../src/components/MessageActionSheet';

jest.mock('react-native', () => ({
  Modal: 'Modal',
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', inset: 0 },
    create: styles => styles,
    hairlineWidth: 1,
  },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

const darkTheme = {
  accent: '#00A884',
  border: '#2A3942',
  error: '#F25244',
  overlay: 'rgba(0, 0, 0, 0.65)',
  primary: '#00A884',
  surface: '#202C33',
  surfaceSubtle: '#182229',
  surfaceVariant: '#2A3942',
  text: '#E9EDEF',
  textMuted: '#667781',
  textSecondary: '#8696A0',
};

function flattenStyle(style) {
  if (!Array.isArray(style)) return style || {};
  return style.reduce((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
}

function renderSheet(overrides = {}) {
  const callbacks = {
    onClose: jest.fn(),
    onCopy: jest.fn(),
    onDelete: jest.fn(),
    onReply: jest.fn(),
    onShare: jest.fn(),
  };
  let tree;
  act(() => {
    tree = renderer.create(
      <MessageActionSheet
        visible
        message={{
          messageId: 'message-1',
          sender: 'remote',
          type: 'text',
          text: 'رسالة للاختبار',
        }}
        theme={darkTheme}
        {...callbacks}
        {...overrides}
      />
    );
  });
  return { callbacks, tree };
}

describe('MessageActionSheet', () => {
  test('exposes all message actions as clear accessible controls', () => {
    const { callbacks, tree } = renderSheet();
    const root = tree.root;

    const expectedActions = [
      ['message-action-reply', 'الرد على الرسالة', callbacks.onReply],
      ['message-action-copy', 'نسخ الرسالة', callbacks.onCopy],
      ['message-action-share', 'مشاركة الرسالة', callbacks.onShare],
      ['message-action-delete', 'حذف الرسالة محلياً', callbacks.onDelete],
    ];

    expectedActions.forEach(([testID, accessibilityLabel, callback]) => {
      const action = root.findByProps({ testID });
      expect(action.props.accessibilityRole).toBe('button');
      expect(action.props.accessibilityLabel).toBe(accessibilityLabel);
      expect(action.props.accessibilityHint).toBeTruthy();
      expect(action.props.accessibilityState).toEqual({ disabled: false });
      act(() => action.props.onPress());
      expect(callback).toHaveBeenCalledTimes(1);
    });

    expect(root.findByProps({ testID: 'message-action-delete' }).props.accessibilityHint)
      .toContain('هذا الجهاز فقط');
  });

  test('uses theme tokens for the dark sheet and supports explicit dismissal', () => {
    const { callbacks, tree } = renderSheet();
    const root = tree.root;

    expect(root.findByProps({ testID: 'message-actions-sheet' }).props.style)
      .toContainEqual(expect.objectContaining({
        backgroundColor: darkTheme.surface,
        borderColor: darkTheme.border,
      }));
    expect(root.findByProps({ testID: 'message-actions-preview' }).props.style)
      .toContainEqual(expect.objectContaining({ backgroundColor: darkTheme.surfaceVariant }));
    expect(root.findByProps({ testID: 'message-action-delete' }).props.style)
      .toContainEqual(expect.objectContaining({ borderColor: darkTheme.error }));

    const modal = root.findByType('Modal');
    expect(modal.props.hardwareAccelerated).toBe(true);

    act(() => modal.props.onRequestClose());
    act(() => root.findByProps({ testID: 'message-actions-close' }).props.onPress());
    act(() => root.findByProps({ testID: 'message-actions-backdrop' }).props.onPress());
    expect(callbacks.onClose).toHaveBeenCalledTimes(3);
  });

  test('forces readable RTL layout while preserving mixed-direction message previews', () => {
    const { tree } = renderSheet({
      message: {
        messageId: 'message-2',
        sender: 'me',
        type: 'text',
        text: 'Report 2026 — جاهز',
      },
    });
    const root = tree.root;
    const sheet = root.findByProps({ testID: 'message-actions-sheet' });
    const preview = root.findByProps({ testID: 'message-actions-preview' });

    expect(flattenStyle(sheet.props.style)).toMatchObject({ direction: 'rtl' });
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(sheet.props.importantForAccessibility).toBe('yes');
    expect(flattenStyle(preview.props.style)).toMatchObject({ flexDirection: 'row' });

    const previewText = preview.findAllByType('Text')
      .find(node => node.props.numberOfLines === 2);
    expect(flattenStyle(previewText.props.style)).toMatchObject({
      textAlign: 'right',
      writingDirection: 'auto',
    });
  });

  test('keeps every control at least 48 points tall and disables missing handlers truthfully', () => {
    const { tree } = renderSheet({ onCopy: undefined });
    const root = tree.root;
    const close = root.findByProps({ testID: 'message-actions-close' });
    const reply = root.findByProps({ testID: 'message-action-reply' });
    const copy = root.findByProps({ testID: 'message-action-copy' });

    expect(flattenStyle(close.props.style)).toMatchObject({ width: 48, height: 48 });
    expect(flattenStyle(reply.props.style).minHeight).toBeGreaterThanOrEqual(48);
    expect(copy.props.disabled).toBe(true);
    expect(copy.props.accessibilityState).toEqual({ disabled: true });
    expect(flattenStyle(copy.props.style).opacity).toBeLessThan(1);
    expect(root.findByProps({ testID: 'message-actions-local-delete-note' }).children.join(''))
      .toContain('لا يزيل الرسالة من جهاز الطرف الآخر');
  });
});

describe('ChatScreen message action integration', () => {
  const chatSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ChatScreen.js'),
    'utf8'
  );

  test('wires reply, copy, share, and confirmed local deletion into the action sheet', () => {
    expect(chatSource).toContain('onReply={replyToSelectedMessage}');
    expect(chatSource).toContain('onCopy={copyMessage}');
    expect(chatSource).toContain('onShare={shareMessage}');
    expect(chatSource).toContain('onDelete={deleteSelectedMessage}');
    expect(chatSource).toContain("Alert.alert('حذف الرسالة محلياً؟'");
    expect(chatSource).toContain('onDeleteMessage?.(selected.messageId)');
  });

  test('offers screen-reader message actions and 48-point primary touch targets', () => {
    expect(chatSource).toContain("name: 'showMessageActions', label: 'فتح خيارات الرسالة'");
    expect(chatSource).toContain('accessibilityHint={messageAccessibilityHint}');
    expect(chatSource).toMatch(/bubble: \{[\s\S]{0,180}?minHeight: 48/);
    expect(chatSource).toMatch(/playBtn: \{ width: 48, height: 48/);
    expect(chatSource).toMatch(/replyDismiss: \{ width: 48, height: 48/);
    expect(chatSource).toContain('accessibilityLabel="تشغيل الرسالة الصوتية"');
    expect(chatSource).toContain('accessibilityState={{ disabled: busy || !item.path }}');
    expect(chatSource).toContain("writingDirection: 'auto'");
  });
});
